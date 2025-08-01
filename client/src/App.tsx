import React, { useState, useCallback, useRef } from 'react';
import { Upload, AlertCircle, CheckCircle, ClipboardCopy } from 'lucide-react';

const API_BASE_URL = import.meta.env.VITE_API_URL || 'https://quickshare-backend-latest.onrender.com';

interface FileUploadResponse {
  code: string;
  expires_at: string;
  file_size: number;
}

interface FileInfo {
  original_name: string;
  file_size: number;
  content_type: string;
  expires_at: string;
  time_remaining: number;
}

const FileTransferApp: React.FC = () => {
  const [activeTab, setActiveTab] = useState<'upload' | 'download'>('upload');
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploadResult, setUploadResult] = useState<FileUploadResponse | null>(null);
  const [downloadCode, setDownloadCode] = useState('');
  const [fileInfo, setFileInfo] = useState<FileInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  const formatTimeRemaining = (seconds: number): string => {
    if (seconds <= 0) return 'Expired';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const extractFilename = (contentDisposition: string | null): string => {
    if (!contentDisposition) return 'download';
    
    // Try to extract filename from Content-Disposition header
    // Format: attachment; filename="filename.ext" or attachment; filename=filename.ext
    const filenameRegex = /filename[^;=\n]*=((['"]).*?\2|[^;\n]*)/;
    const match = contentDisposition.match(filenameRegex);
    
    if (match && match[1]) {
      const filename = match[1].replace(/['"]/g, ''); // Remove quotes
      return decodeURIComponent(filename) || 'download';
    }
    
    // Fallback: try filename* (RFC 5987)
    const filenameStarRegex = /filename\*=UTF-8''([^;\n]*)/;
    const starMatch = contentDisposition.match(filenameStarRegex);
    
    if (starMatch && starMatch[1]) {
      return decodeURIComponent(starMatch[1]) || 'download';
    }
    
    return 'download';
  };

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  }, []);

  const handleFileSelect = (file: File) => {
    setError('');
    setSuccess('');
    setUploadResult(null);
    setCopied(false);

    if (file.size > MAX_FILE_SIZE) {
      setError(`File too large. Max is ${formatFileSize(MAX_FILE_SIZE)}`);
      return;
    }

    setUploadFile(file);
  };

  const handleFileInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) handleFileSelect(file);
  };

  const uploadFileToServer = async () => {
    if (!uploadFile) return;
    setLoading(true);
    setError('');
    setUploadProgress(0);

    try {
      const formData = new FormData();
      formData.append('file', uploadFile);

      // Create XMLHttpRequest for progress tracking
      const xhr = new XMLHttpRequest();
      
      // Promise wrapper for XMLHttpRequest
      const uploadPromise = new Promise<FileUploadResponse>((resolve, reject) => {
        xhr.upload.onprogress = (event) => {
          if (event.lengthComputable) {
            const progress = Math.round((event.loaded / event.total) * 100);
            setUploadProgress(progress);
          }
        };

        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const result = JSON.parse(xhr.responseText);
              resolve(result);
            } catch {
              reject(new Error('Invalid response format'));
            }
          } else {
            try {
              const errorData = JSON.parse(xhr.responseText);
              reject(new Error(errorData.detail || 'Upload failed'));
            } catch {
              reject(new Error(`Upload failed with status ${xhr.status}`));
            }
          }
        };

        xhr.onerror = () => reject(new Error('Network error during upload'));
        xhr.ontimeout = () => reject(new Error('Upload timeout'));

        xhr.open('POST', `${API_BASE_URL}/upload`);
        xhr.send(formData);
      });

      const result = await uploadPromise;
      setUploadResult(result);
      setSuccess('Uploaded!');
      setUploadFile(null);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
      setUploadProgress(0);
    } finally {
      setLoading(false);
    }
  };

  const fetchFileInfo = async (code: string) => {
    if (!code.trim()) return;
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/info/${code.toUpperCase()}`);
      if (!response.ok) throw new Error((await response.json()).detail || 'File not found');

      const info: FileInfo = await response.json();
      setFileInfo(info);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to fetch file info');
      setFileInfo(null);
    } finally {
      setLoading(false);
    }
  };

  const downloadFile = async () => {
    if (!downloadCode.trim()) return;
    setLoading(true);
    setError('');

    try {
      const response = await fetch(`${API_BASE_URL}/download`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: downloadCode.toUpperCase() }),
      });

      if (!response.ok) throw new Error((await response.json()).detail || 'Download failed');

      const blob = await response.blob();
      const contentDisposition = response.headers.get('content-disposition');
      
      // Use the improved filename extraction
      let filename = extractFilename(contentDisposition);
      
      // If we have file info, use that as fallback
      if (filename === 'download' && fileInfo?.original_name) {
        filename = fileInfo.original_name;
      }

      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);

      setSuccess('Downloaded!');
      setDownloadCode('');
      setFileInfo(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setLoading(false);
    }
  };

  const handleCopy = () => {
    if (uploadResult?.code) {
      navigator.clipboard.writeText(uploadResult.code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-base-100 text-base-content p-4 sm:p-6 md:p-8 flex items-center justify-center">
      <div className="w-full max-w-3xl space-y-6">
        <div className="text-center">
          <h1 className="text-6xl font-bold">🚀 QuickShare</h1>
          <p className="text-lg text-base-content/70 mt-4">Secure expiring file links. Send. Receive. Done.</p>
        </div>

        <div role="tablist" className="tabs tabs-boxed justify-center">
          <button role="tab" className={`tab ${activeTab === 'upload' ? 'tab-active' : ''}`} onClick={() => setActiveTab('upload')}>Upload</button>
          <button role="tab" className={`tab ${activeTab === 'download' ? 'tab-active' : ''}`} onClick={() => setActiveTab('download')}>Download</button>
        </div>

        {error && <div className="alert alert-error"><AlertCircle className="h-5 w-5" /> {error}</div>}
        {success && <div className="alert alert-success"><CheckCircle className="h-5 w-5" /> {success}</div>}

        {activeTab === 'upload' && (
          <div className="card bg-base-200">
            <div className="card-body space-y-4">
              {!uploadResult ? (
                <>
                  <div
                    className={`p-6 border-2 border-dashed rounded cursor-pointer text-center ${dragOver ? 'border-primary bg-primary/10' : 'border-base-300'}`}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <Upload className="mx-auto h-10 w-10 text-base-content/50" />
                    <p>Drop or choose a file (max {formatFileSize(MAX_FILE_SIZE)})</p>
                    <input
                      ref={fileInputRef}
                      type="file"
                      onChange={handleFileInputChange}
                      className="file-input mt-4 w-full sm:w-auto"
                    />
                  </div>

                  {uploadFile && (
                    <div className="space-y-4">
                      <div className="flex flex-col sm:flex-row justify-between items-center gap-2">
                        <div className="text-center sm:text-left">
                          <p>{uploadFile.name}</p>
                          <p className="text-sm text-base-content/60">{formatFileSize(uploadFile.size)}</p>
                        </div>
                        <button className="btn btn-primary w-full sm:w-auto" disabled={loading} onClick={uploadFileToServer}>
                          {loading && <span className="loading loading-spinner"></span>} Upload
                        </button>
                      </div>
                      
                      {loading && (
                        <div className="space-y-2">
                          <div className="flex justify-between text-sm">
                            <span>Uploading...</span>
                            <span>{uploadProgress}%</span>
                          </div>
                          <div className="w-full bg-base-300 rounded-full h-2">
                            <div 
                              className="bg-primary h-2 rounded-full transition-all duration-300 ease-out" 
                              style={{ width: `${uploadProgress}%` }}
                            ></div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </>
              ) : (
                <div className="text-center space-y-4">
                  <CheckCircle className="h-12 w-12 text-success mx-auto" />
                  <p className="font-bold text-xl">Your Code</p>
                  <div className="flex justify-center items-center gap-2">
                    <div className="p-4 bg-success text-success-content font-mono text-2xl rounded">{uploadResult.code}</div>
                    <button className="btn btn-outline btn-sm" onClick={handleCopy}>
                      <ClipboardCopy className="h-4 w-4" />
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                  <p className="text-sm">Expires: {new Date(uploadResult.expires_at).toLocaleTimeString()}</p>
                  <button className="btn btn-outline" onClick={() => setUploadResult(null)}>Upload Another</button>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'download' && (
          <div className="card bg-base-200">
            <div className="card-body space-y-4">
              <input
                type="text"
                placeholder="Enter 6-char code"
                className="input input-bordered w-full text-center font-mono uppercase"
                value={downloadCode}
                onChange={(e) => setDownloadCode(e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6))}
              />
              <button className="btn btn-outline w-full" onClick={() => fetchFileInfo(downloadCode)} disabled={!downloadCode}>Check File</button>

              {fileInfo && (
                <div className="bg-base-100 p-4 rounded border border-base-300">
                  <p className="font-bold">{fileInfo.original_name}</p>
                  <p className="text-sm">Size: {formatFileSize(fileInfo.file_size)}</p>
                  <p className="text-sm">Type: {fileInfo.content_type}</p>
                  <p className="text-sm text-warning">Expires in: {formatTimeRemaining(fileInfo.time_remaining)}</p>
                </div>
              )}

              <button className="btn btn-primary w-full" onClick={downloadFile} disabled={!downloadCode || loading}>
                {loading && <span className="loading loading-spinner"></span>} Download
              </button>

              <p className="text-center text-xs text-base-content/50">File is deleted after download or expiry</p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default FileTransferApp;