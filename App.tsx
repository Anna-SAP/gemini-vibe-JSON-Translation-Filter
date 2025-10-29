import React, { useState, useEffect, useRef, useCallback } from 'react';
import ClipboardIcon from './components/icons/ClipboardIcon';
import CheckIcon from './components/icons/CheckIcon';

type Status = 'idle' | 'loading' | 'filtering' | 'ready' | 'error' | 'copying';

const workerCode = `
  let allTranslations = [];
  let currentFilteredTranslations = [];
  const PAGE_SIZE = 50;

  const postPage = (page, type, jobId) => {
      const start = page * PAGE_SIZE;
      const end = start + PAGE_SIZE;
      const pageData = currentFilteredTranslations.slice(start, end);
      const hasMore = end < currentFilteredTranslations.length;

      let pageString = '';
      if (pageData.length > 0) {
          pageString = pageData.map(item => JSON.stringify(item, null, 2)).join(',\\n');
      }

      const message = {
          type,
          results: pageString,
          hasMore,
          page,
          jobId,
      };

      if (type === 'loaded') {
          message.total = allTranslations.length;
          message.count = currentFilteredTranslations.length;
      } else if (type === 'filtered') {
          message.count = currentFilteredTranslations.length;
      }
      
      self.postMessage(message);
  };

  self.onmessage = (event) => {
    const { type, payload, jobId } = event.data;

    try {
      switch (type) {
        case 'load':
          const data = JSON.parse(payload);
          if (!Array.isArray(data)) {
            throw new Error("JSON is not an array.");
          }
          if (data.length > 0 && (typeof data[0].key === 'undefined' || typeof data[0]['en-US'] === 'undefined')) {
              throw new Error("JSON objects do not have the required 'key' and 'en-US' properties.");
          }
          allTranslations = data;
          currentFilteredTranslations = allTranslations;
          postPage(0, 'loaded', jobId);
          break;

        case 'filter':
          const { sourceSearch, targetSearch } = payload;
          
          if (!allTranslations.length) {
              currentFilteredTranslations = [];
          } else {
              const lowerSourceSearch = sourceSearch.trim().toLowerCase();
              const lowerTargetSearch = targetSearch.trim().toLowerCase();

              if (!lowerSourceSearch && !lowerTargetSearch) {
                  currentFilteredTranslations = allTranslations;
              } else {
                   currentFilteredTranslations = allTranslations.filter(item => {
                      const sourceMatch = lowerSourceSearch
                          ? item['en-US']?.toLowerCase().includes(lowerSourceSearch)
                          : true;

                      if (!sourceMatch) return false;

                      const targetMatch = lowerTargetSearch
                          ? Object.entries(item).some(([key, value]) => {
                              if (key === 'key' || key === 'en-US' || typeof value !== 'string') {
                              return false;
                              }
                              return value.toLowerCase().includes(lowerTargetSearch);
                          })
                          : true;

                      return sourceMatch && targetMatch;
                  });
              }
          }
          postPage(0, 'filtered', jobId);
          break;

        case 'get-next-page':
          const { page } = payload;
          postPage(page, 'page-data', jobId);
          break;
        
        case 'get-full-filtered-json':
          const fullJson = JSON.stringify(currentFilteredTranslations, null, 2);
          self.postMessage({ type: 'full-json-result', fullJson, jobId });
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      self.postMessage({ type: 'error', message: \`Error processing data: \${message}\`, jobId });
    }
  };
`;


const App: React.FC = () => {
  const [sourceSearch, setSourceSearch] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [isCopied, setIsCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  // --- State for worker-based and paginated logic ---
  const [status, setStatus] = useState<Status>('idle');
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);
  const [resultsString, setResultsString] = useState('');
  const [hasMore, setHasMore] = useState(false);
  const [currentPage, setCurrentPage] = useState(0);

  const workerRef = useRef<Worker | null>(null);
  const preRef = useRef<HTMLPreElement | null>(null);
  const jobIdRef = useRef<number>(0); // Ref to track the current job ID

  useEffect(() => {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    workerRef.current = new Worker(workerUrl);

    workerRef.current.onmessage = (event: MessageEvent<{ type: string; jobId?: number; [key: string]: any }>) => {
      const { type, jobId, results, count, total, hasMore: newHasMore, page, message, fullJson } = event.data;

      // --- CRITICAL: Ignore messages from old jobs ---
      if (jobId !== undefined && jobId !== jobIdRef.current) {
        return;
      }

      switch (type) {
        case 'loaded':
        case 'filtered':
          setResultsString(results);
          setFilteredCount(count);
          if (type === 'loaded') {
            setTotalCount(total);
          }
          setHasMore(newHasMore);
          setCurrentPage(page);
          if (preRef.current) {
            preRef.current.scrollTop = 0;
          }
          setStatus('ready');
          break;

        case 'page-data':
          if (results) {
            setResultsString(prev => (prev ? `${prev},\n${results}` : results));
          }
          setHasMore(newHasMore);
          setCurrentPage(page);
          break;
        
        case 'full-json-result':
          navigator.clipboard.writeText(fullJson).then(() => {
            setIsCopied(true);
            setTimeout(() => setIsCopied(false), 2000);
          });
          setStatus('ready');
          break;

        case 'error':
          setError(message);
          setFileName(null);
          setTotalCount(0);
          setFilteredCount(0);
          setResultsString('');
          setStatus('error');
          break;
      }
    };

    workerRef.current.onerror = (e) => {
      console.error('Worker error:', e);
      setError('An unexpected error occurred with the processing worker.');
      setStatus('error');
    };

    return () => {
      workerRef.current?.terminate();
      URL.revokeObjectURL(workerUrl);
    };
  }, []);
  
  const handleApplyFilters = useCallback(() => {
    if (status === 'idle' || status === 'loading' || status === 'filtering') return;
    
    jobIdRef.current = Date.now(); // Create a new job ID for this filter operation
    setStatus('filtering');
    setResultsString(''); // Clear previous results for instant feedback
    setHasMore(false);
    workerRef.current?.postMessage({
        type: 'filter',
        jobId: jobIdRef.current,
        payload: { sourceSearch, targetSearch },
    });
  }, [status, sourceSearch, targetSearch]);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Enter') {
          handleApplyFilters();
      }
  };

  const processFile = (file: File) => {
    setFileName(file.name);
    setError(null);
    setStatus('loading');
    setTotalCount(0);
    setFilteredCount(0);
    setResultsString('');
    setSourceSearch('');
    setTargetSearch('');
    setHasMore(false);
    jobIdRef.current = Date.now(); // Create a new job ID for the file load

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      workerRef.current?.postMessage({ type: 'load', jobId: jobIdRef.current, payload: text });
    };
    reader.onerror = () => {
      setError('Failed to read the file.');
      setStatus('error');
    };
    reader.readAsText(file);
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) processFile(file);
  };
  
  const handleCopy = useCallback(() => {
    if (!resultsString || status !== 'ready') return;
    setStatus('copying');
    jobIdRef.current = Date.now();
    workerRef.current?.postMessage({
        type: 'get-full-filtered-json',
        jobId: jobIdRef.current
    });
  }, [resultsString, status]);

  const handleScroll = useCallback(() => {
    if (!preRef.current || !hasMore || status !== 'ready') return;

    const { scrollTop, scrollHeight, clientHeight } = preRef.current;
    if (scrollHeight - scrollTop < clientHeight * 1.5) {
      // Don't change status, just fetch more data
      workerRef.current?.postMessage({
        type: 'get-next-page',
        jobId: jobIdRef.current, // Use current job ID for pagination
        payload: { page: currentPage + 1 }
      });
    }
  }, [hasMore, status, currentPage]);

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === 'application/json') {
      processFile(file);
    } else {
      setError('Invalid file type. Please drop a JSON file.');
    }
  };


  const renderContent = () => {
    if (status === 'loading') return <span className="text-gray-500 flex items-center justify-center h-full">Processing file...</span>;
    if (status === 'idle') return <span className="text-gray-500 flex items-center justify-center h-full">Upload a JSON file to see the results.</span>;
    if (status === 'filtering') return <span className="text-gray-500 flex items-center justify-center h-full">Filtering...</span>;
    
    if (filteredCount === 0) {
      if (sourceSearch || targetSearch) return <span className="text-gray-500 flex items-center justify-center h-full">No results match your criteria.</span>;
      return <code>[]</code>;
    }

    const moreIndicator = hasMore ? `,\n  // Scrolling will load more results...` : '';
    return <code>{`[\n${resultsString}${moreIndicator}\n]`}</code>
  };

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 font-sans p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-cyan-400">JSON Translation Filter</h1>
          <p className="text-gray-400 mt-2">Upload, search, and manage your multilingual translation files with ease.</p>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-2 gap-8">
          <div className="bg-gray-800 p-6 rounded-lg shadow-lg flex flex-col gap-6 h-fit">
            <div>
                <h2 className="text-2xl font-semibold text-white mb-4 border-b border-gray-700 pb-2">Controls</h2>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-300 mb-2" htmlFor="file-upload">
                Upload JSON File
              </label>
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`mt-1 flex justify-center px-6 pt-5 pb-6 border-2 border-dashed rounded-md transition-colors ${isDragging ? 'border-cyan-400' : 'border-gray-600'}`}
              >
                <div className="space-y-1 text-center">
                  <svg className="mx-auto h-12 w-12 text-gray-500" stroke="currentColor" fill="none" viewBox="0 0 48 48" aria-hidden="true"><path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                  <div className="flex text-sm text-gray-500">
                    <label htmlFor="file-upload" className={`relative cursor-pointer bg-gray-800 rounded-md font-medium text-cyan-400 hover:text-cyan-300 focus-within:outline-none focus-within:ring-2 focus-within:ring-offset-2 focus-within:ring-offset-gray-800 focus-within:ring-cyan-500 ${status === 'loading' ? 'opacity-50 cursor-not-allowed' : ''}`}>
                      <span>Upload a file</span>
                      <input id="file-upload" name="file-upload" type="file" className="sr-only" accept=".json" onChange={handleFileChange} disabled={status === 'loading'}/>
                    </label>
                    <p className="pl-1">or drag and drop</p>
                  </div>
                  <p className="text-xs text-gray-600">JSON files only</p>
                </div>
              </div>
              {fileName && status !== 'loading' && status !== 'error' && <p className="text-sm text-green-400 mt-2">Loaded: {fileName} ({totalCount} items)</p>}
              {status === 'loading' && <p className="text-sm text-yellow-400 mt-2">Loading and processing {fileName}...</p>}
              {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
            </div>

            <div>
              <label htmlFor="source-search" className="block text-sm font-medium text-gray-300">
                Search in Source (en-US)
              </label>
              <input
                type="text"
                id="source-search"
                value={sourceSearch}
                onChange={(e) => setSourceSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g., Hello world"
                className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md shadow-sm py-2 px-3 text-white focus:outline-none focus:ring-cyan-500 focus:border-cyan-500 sm:text-sm"
                disabled={status === 'idle' || status === 'loading'}
              />
            </div>
            <div>
              <label htmlFor="target-search" className="block text-sm font-medium text-gray-300">
                Search in Target Translations
              </label>
              <input
                type="text"
                id="target-search"
                value={targetSearch}
                onChange={(e) => setTargetSearch(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder="e.g., Bonjour le monde"
                className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md shadow-sm py-2 px-3 text-white focus:outline-none focus:ring-cyan-500 focus:border-cyan-500 sm:text-sm"
                disabled={status === 'idle' || status === 'loading'}
              />
            </div>
            <div className="pt-2">
                <button
                    onClick={handleApplyFilters}
                    disabled={status === 'idle' || status === 'loading' || status === 'filtering'}
                    className="w-full inline-flex items-center justify-center px-4 py-2 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-cyan-600 hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-cyan-500 disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors duration-200"
                >
                    {status === 'filtering' ? 'Filtering...' : 'Apply Filters'}
                </button>
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg shadow-lg flex flex-col">
            <div className="flex justify-between items-center p-4 border-b border-gray-700">
              <h2 className="text-xl font-semibold text-white">Results ({status === 'filtering' ? '...' : filteredCount})</h2>
              <button
                onClick={handleCopy}
                disabled={isCopied || status !== 'ready' || !resultsString}
                className={`inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md shadow-sm text-white ${
                  isCopied
                    ? 'bg-green-600'
                    : 'bg-cyan-600 hover:bg-cyan-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-offset-gray-800 focus:ring-cyan-500'
                } disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors duration-200`}
              >
                {isCopied ? (
                  <>
                    <CheckIcon className="h-5 w-5 mr-2" />
                    Copied!
                  </>
                ) : (
                  <>
                    <ClipboardIcon className="h-5 w-5 mr-2" />
                    {status === 'copying' ? 'Preparing...' : 'Copy JSON'}
                  </>
                )}
              </button>
            </div>
            <div className="flex-grow p-1 overflow-hidden">
              <pre ref={preRef} onScroll={handleScroll} className="w-full h-[60vh] overflow-auto bg-gray-900 text-sm p-4 rounded-b-md custom-scrollbar">
                  {renderContent()}
              </pre>
            </div>
          </div>
        </main>
      </div>
       <style>{`
          .custom-scrollbar::-webkit-scrollbar {
              width: 8px;
              height: 8px;
          }
          .custom-scrollbar::-webkit-scrollbar-track {
              background: #1f2937;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb {
              background: #4b5563;
              border-radius: 4px;
          }
          .custom-scrollbar::-webkit-scrollbar-thumb:hover {
              background: #6b7280;
          }
      `}</style>
    </div>
  );
};

export default App;
