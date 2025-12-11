import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ClipboardIcon from './components/icons/ClipboardIcon';
import CheckIcon from './components/icons/CheckIcon';
import { TranslationObject } from './types';

type Status = 'idle' | 'loading' | 'filtering' | 'ready' | 'error' | 'copying';

const workerCode = `
  let allTranslations = [];
  let primaryFilteredTranslations = []; // Result of sidebar filters
  let finalFilteredTranslations = []; // Result of primary + refine
  let currentRefineQuery = '';
  let detectedKeys = []; // Stores keys found in the first item (excluding 'key')

  const PAGE_SIZE = 50;

  const generatePage = (page, data, view, selectedLanguages) => {
      const start = page * PAGE_SIZE;
      const end = start + PAGE_SIZE;
      const pageData = data.slice(start, end);
      const hasMore = end < data.length;

      let resultData = pageData;

      if (view === 'subset' && Array.isArray(selectedLanguages)) {
         resultData = pageData.map(item => {
            const newItem = { key: item.key };
            selectedLanguages.forEach(lang => {
               if (item[lang] !== undefined) {
                 newItem[lang] = item[lang];
               }
            });
            return newItem;
         });
      }

      // Return raw objects now, not strings
      return { results: resultData, hasMore };
  };

  const applyRefine = () => {
     if (!currentRefineQuery) {
         finalFilteredTranslations = primaryFilteredTranslations;
     } else {
         const lowerQuery = currentRefineQuery.toLowerCase();
         finalFilteredTranslations = primaryFilteredTranslations.filter(item => 
             JSON.stringify(item).toLowerCase().includes(lowerQuery)
         );
     }
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
          if (data.length > 0 && (typeof data[0].key === 'undefined')) {
              throw new Error("JSON objects must have a 'key' property.");
          }
          
          allTranslations = data;
          primaryFilteredTranslations = allTranslations;
          finalFilteredTranslations = allTranslations;
          currentRefineQuery = '';
          
          // Extract languages from the first item
          detectedKeys = data.length > 0 
            ? Object.keys(data[0]).filter(k => k !== 'key')
            : [];

          self.postMessage({ 
            type: 'loaded', 
            total: allTranslations.length, 
            count: finalFilteredTranslations.length, 
            languages: detectedKeys,
            jobId 
          });
          break;

        case 'filter':
          const { 
            keySearch,
            sourceSearch, 
            targetSearch, 
            matchKeyWholeWord,
            matchSourceWholeWord, 
            matchTargetWholeWord,
            matchKeyCase,
            matchSourceCase,
            matchTargetCase
          } = payload;
          
          // Reset refine query when main filter changes
          currentRefineQuery = ''; 
          
          if (!allTranslations.length) {
              primaryFilteredTranslations = [];
          } else {
              // Pre-process search terms based on case sensitivity
              const effectiveKeySearch = matchKeyCase ? keySearch : keySearch.toLowerCase();
              const effectiveSourceSearch = matchSourceCase ? sourceSearch : sourceSearch.toLowerCase();
              const effectiveTargetSearch = matchTargetCase ? targetSearch : targetSearch.toLowerCase();

              if (keySearch === '' && sourceSearch === '' && targetSearch === '') {
                  primaryFilteredTranslations = allTranslations;
              } else {
                   primaryFilteredTranslations = allTranslations.filter(item => {
                      // Key Logic
                      let keyMatch = true;
                      if (keySearch !== '') {
                          const itemKey = item.key;
                          if (typeof itemKey !== 'string') {
                              keyMatch = false;
                          } else {
                              const effectiveItemKey = matchKeyCase ? itemKey : itemKey.toLowerCase();
                              if (matchKeyWholeWord) {
                                  keyMatch = effectiveItemKey === effectiveKeySearch;
                              } else {
                                  keyMatch = effectiveItemKey.includes(effectiveKeySearch);
                              }
                          }
                      }
                      
                      if (!keyMatch) return false;

                      // Source Logic
                      let sourceMatch = true;
                      if (sourceSearch !== '') {
                          const itemValue = item['en-US'];
                          if (typeof itemValue !== 'string') {
                              sourceMatch = false;
                          } else {
                              const effectiveItemValue = matchSourceCase ? itemValue : itemValue.toLowerCase();
                              if (matchSourceWholeWord) {
                                  sourceMatch = effectiveItemValue === effectiveSourceSearch;
                              } else {
                                  sourceMatch = effectiveItemValue.includes(effectiveSourceSearch);
                              }
                          }
                      }

                      if (!sourceMatch) return false;

                      // Target Logic
                      let targetMatch = true;
                      if (targetSearch !== '') {
                          // Default to false, try to find ANY match in target languages
                          targetMatch = false;
                          
                          // Use detectedKeys to iterate only over known language columns
                          // This avoids iterating over unexpected metadata fields or 'en-US' if we explicitly skip it
                          for (let i = 0; i < detectedKeys.length; i++) {
                              const langKey = detectedKeys[i];
                              
                              // Strictly exclude 'en-US' from Target search
                              if (langKey === 'en-US') continue;
                              
                              const val = item[langKey];
                              // Ensure we are checking a string value and it exists
                              if (val && typeof val === 'string') {
                                  const effectiveValue = matchTargetCase ? val : val.toLowerCase();
                                  
                                  if (matchTargetWholeWord) {
                                      if (effectiveValue === effectiveTargetSearch) {
                                          targetMatch = true;
                                          break;
                                      }
                                  } else {
                                      if (effectiveValue.includes(effectiveTargetSearch)) {
                                          targetMatch = true;
                                          break;
                                      }
                                  }
                              }
                          }
                      }

                      return targetMatch;
                  });
              }
          }
          applyRefine();
          self.postMessage({ type: 'filtered', count: finalFilteredTranslations.length, jobId });
          break;

        case 'refine':
          currentRefineQuery = payload.query;
          applyRefine();
          self.postMessage({ type: 'filtered', count: finalFilteredTranslations.length, jobId });
          break;

        case 'get-page':
          const { page, view, selectedLanguages } = payload;
          // 'view' can be 'main' or 'subset'
          // We use finalFilteredTranslations for everything now
          const { results, hasMore } = generatePage(page, finalFilteredTranslations, view, selectedLanguages);
          
          self.postMessage({
            type: 'page-data',
            view,
            results: results,
            hasMore,
            page,
            jobId
          });
          break;
        
        case 'get-full-json':
          const { view: jsonView, selectedLanguages: jsonSelectedLangs } = payload;
          let fullJsonData = finalFilteredTranslations;
          
          if (jsonView === 'subset' && Array.isArray(jsonSelectedLangs)) {
             fullJsonData = finalFilteredTranslations.map(item => {
                const newItem = { key: item.key };
                jsonSelectedLangs.forEach(lang => {
                   if (item[lang] !== undefined) {
                     newItem[lang] = item[lang];
                   }
                });
                return newItem;
             });
          }

          const fullJson = JSON.stringify(fullJsonData, null, 2);
          self.postMessage({ type: 'full-json-result', fullJson, view: jsonView, jobId });
          break;

        case 'get-translated-json':
          const { selectedLanguages: transLangs } = payload;
          const translatedData = finalFilteredTranslations.reduce((acc, item) => {
              const newItem = { key: item.key };
              let hasNonEnglishTranslation = false;
              
              if (Array.isArray(transLangs)) {
                  transLangs.forEach(lang => {
                      if (item[lang] !== undefined) {
                          newItem[lang] = item[lang];
                          // Check if this is a non-English language with content
                          if (lang !== 'en-US') {
                              hasNonEnglishTranslation = true;
                          }
                      }
                  });
              }
              
              // Only add to result if we found at least one non-English translation
              if (hasNonEnglishTranslation) {
                  acc.push(newItem);
              }
              return acc;
          }, []);
          
          const translatedJson = JSON.stringify(translatedData, null, 2);
          self.postMessage({ type: 'translated-json-result', translatedJson, jobId });
          break;

        case 'get-all-keys':
          const keysList = finalFilteredTranslations
              .map(item => item.key)
              .filter(k => k !== undefined && k !== null)
              .join('\\n');
          self.postMessage({ type: 'all-keys-result', keysList, jobId });
          break;
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      self.postMessage({ type: 'error', message: \`Error processing data: \${message}\`, jobId });
    }
  };
`;

const App: React.FC = () => {
  const [keySearch, setKeySearch] = useState('');
  const [sourceSearch, setSourceSearch] = useState('');
  const [targetSearch, setTargetSearch] = useState('');
  const [matchKeyWholeWord, setMatchKeyWholeWord] = useState(false);
  const [matchSourceWholeWord, setMatchSourceWholeWord] = useState(false);
  const [matchTargetWholeWord, setMatchTargetWholeWord] = useState(false);
  const [matchKeyCase, setMatchKeyCase] = useState(false);
  const [matchSourceCase, setMatchSourceCase] = useState(false);
  const [matchTargetCase, setMatchTargetCase] = useState(false);
  const [refineQuery, setRefineQuery] = useState('');

  const [fileName, setFileName] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Language Filtering State
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);
  const [selectedLanguages, setSelectedLanguages] = useState<Set<string>>(new Set());
  
  // Ref to track selected languages for stable access in callbacks (fixes stale closure bugs)
  const selectedLanguagesRef = useRef<Set<string>>(new Set());

  // App Status
  const [status, setStatus] = useState<Status>('idle');
  const [totalCount, setTotalCount] = useState(0);
  const [filteredCount, setFilteredCount] = useState(0);

  // Main Results State
  const [mainResults, setMainResults] = useState<TranslationObject[]>([]);
  const [mainHasMore, setMainHasMore] = useState(false);
  const [mainCurrentPage, setMainCurrentPage] = useState(0);
  const [isMainCopied, setIsMainCopied] = useState(false);

  // Filtered (Subset) Results State
  const [subsetResults, setSubsetResults] = useState<TranslationObject[]>([]);
  const [subsetHasMore, setSubsetHasMore] = useState(false);
  const [subsetCurrentPage, setSubsetCurrentPage] = useState(0);
  const [isSubsetCopied, setIsSubsetCopied] = useState(false);
  const [isSubsetKeysCopied, setIsSubsetKeysCopied] = useState(false);
  const [isTranslatedCopied, setIsTranslatedCopied] = useState(false);

  const workerRef = useRef<Worker | null>(null);
  const mainPreRef = useRef<HTMLDivElement | null>(null);
  const subsetPreRef = useRef<HTMLDivElement | null>(null);
  const jobIdRef = useRef<number>(0);

  // Update the ref whenever state changes
  useEffect(() => {
    selectedLanguagesRef.current = selectedLanguages;
  }, [selectedLanguages]);

  // Format language code to display name
  const getDisplayName = useMemo(() => {
    let langNames: Intl.DisplayNames | undefined;
    try {
      langNames = new Intl.DisplayNames(['en'], { type: 'language' });
    } catch (e) {
      // Fallback if not supported
    }
    
    return (code: string) => {
        if (!langNames) return code;
        try {
            const name = langNames.of(code);
            return `${name} (${code})`;
        } catch (e) {
            return code;
        }
    };
  }, []);

  // Sort languages to put en-US first, then alphabetical
  const sortedLanguages = useMemo(() => {
    return [...availableLanguages].sort((a, b) => {
      if (a === 'en-US') return -1;
      if (b === 'en-US') return 1;
      return a.localeCompare(b);
    });
  }, [availableLanguages]);

  // Stable request page function using the Ref
  const requestPage = useCallback((page: number, view: 'main' | 'subset', langsOverride?: string[]) => {
      const langs = langsOverride || Array.from(selectedLanguagesRef.current);
      workerRef.current?.postMessage({
          type: 'get-page',
          jobId: jobIdRef.current,
          payload: { page, view, selectedLanguages: langs }
      });
  }, []);

  useEffect(() => {
    const blob = new Blob([workerCode], { type: 'application/javascript' });
    const workerUrl = URL.createObjectURL(blob);
    workerRef.current = new Worker(workerUrl);

    workerRef.current.onmessage = (event: MessageEvent<{ type: string; jobId?: number; [key: string]: any }>) => {
      const { type, jobId, results, count, total, hasMore, page, message, fullJson, translatedJson, languages, view, keysList } = event.data;

      if (jobId !== undefined && jobId !== jobIdRef.current) return;

      switch (type) {
        case 'loaded':
          setAvailableLanguages(languages || []);
          setSelectedLanguages(new Set(languages || []));
          
          setTotalCount(total);
          setFilteredCount(count);
          
          // Initial request for data
          requestPage(0, 'main');
          // Explicitly pass languages here to ensure the first render is correct regardless of state update timing
          requestPage(0, 'subset', languages || []);
          setStatus('ready');
          break;

        case 'filtered':
          setFilteredCount(count);
          // Clear current displays
          setMainResults([]);
          setSubsetResults([]);
          // Request first pages - this will now use the selectedLanguagesRef
          requestPage(0, 'main');
          requestPage(0, 'subset');
          
          if (mainPreRef.current) mainPreRef.current.scrollTop = 0;
          if (subsetPreRef.current) subsetPreRef.current.scrollTop = 0;
          
          setStatus('ready');
          break;

        case 'page-data':
          if (view === 'main') {
             setMainResults(prev => (page === 0 ? results : [...prev, ...results]));
             setMainHasMore(hasMore);
             setMainCurrentPage(page);
          } else if (view === 'subset') {
             setSubsetResults(prev => (page === 0 ? results : [...prev, ...results]));
             setSubsetHasMore(hasMore);
             setSubsetCurrentPage(page);
          }
          break;
        
        case 'full-json-result':
          navigator.clipboard.writeText(fullJson).then(() => {
            if (view === 'main') {
                setIsMainCopied(true);
                setTimeout(() => setIsMainCopied(false), 2000);
            } else {
                setIsSubsetCopied(true);
                setTimeout(() => setIsSubsetCopied(false), 2000);
            }
            setStatus('ready');
          });
          break;

        case 'translated-json-result':
          navigator.clipboard.writeText(translatedJson).then(() => {
              setIsTranslatedCopied(true);
              setTimeout(() => setIsTranslatedCopied(false), 2000);
              setStatus('ready');
          });
          break;
        
        case 'all-keys-result':
          navigator.clipboard.writeText(keysList).then(() => {
              setIsSubsetKeysCopied(true);
              setTimeout(() => setIsSubsetKeysCopied(false), 2000);
              setStatus('ready');
          });
          break;

        case 'error':
          setError(message);
          setFileName(null);
          setTotalCount(0);
          setFilteredCount(0);
          setMainResults([]);
          setSubsetResults([]);
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
  }, [requestPage]);

  // Live update filtered view when selected languages change
  useEffect(() => {
    if (status === 'ready') {
        setSubsetResults([]);
        requestPage(0, 'subset');
    }
  }, [selectedLanguages, status, requestPage]);
  
  const handleApplyFilters = useCallback(() => {
    if (status === 'loading') return;
    
    // Start filter job
    jobIdRef.current = Date.now();
    setStatus('filtering');
    setMainResults([]); 
    setSubsetResults([]);
    setRefineQuery(''); // Reset refine query on new search
    
    workerRef.current?.postMessage({
        type: 'filter',
        jobId: jobIdRef.current,
        payload: { 
          keySearch,
          sourceSearch, 
          targetSearch, 
          matchKeyWholeWord,
          matchSourceWholeWord, 
          matchTargetWholeWord,
          matchKeyCase,
          matchSourceCase,
          matchTargetCase
        },
    });
  }, [status, keySearch, sourceSearch, targetSearch, matchKeyWholeWord, matchSourceWholeWord, matchTargetWholeWord, matchKeyCase, matchSourceCase, matchTargetCase]);

  const handleRefineSearch = useCallback((query: string) => {
    setRefineQuery(query);
    if (status === 'loading') return;
    
    jobIdRef.current = Date.now();
    setStatus('filtering');
    setMainResults([]); 
    setSubsetResults([]);
    
    workerRef.current?.postMessage({
        type: 'refine',
        jobId: jobIdRef.current,
        payload: { query },
    });
  }, [status]);

  const handleLanguageChange = (lang: string) => {
      const newSet = new Set(selectedLanguages);
      if (newSet.has(lang)) {
          newSet.delete(lang);
      } else {
          newSet.add(lang);
      }
      setSelectedLanguages(newSet);
  };
  
  const handleSelectAll = () => setSelectedLanguages(new Set(availableLanguages));
  const handleDeselectAll = () => setSelectedLanguages(new Set());

  const processFile = (file: File) => {
    setFileName(file.name);
    setError(null);
    setStatus('loading');
    setTotalCount(0);
    setFilteredCount(0);
    setMainResults([]);
    setSubsetResults([]);
    setKeySearch('');
    setSourceSearch('');
    setTargetSearch('');
    setRefineQuery('');
    setMatchKeyWholeWord(false);
    setMatchSourceWholeWord(false);
    setMatchTargetWholeWord(false);
    setMatchKeyCase(false);
    setMatchSourceCase(false);
    setMatchTargetCase(false);
    setAvailableLanguages([]);
    setSelectedLanguages(new Set());
    
    jobIdRef.current = Date.now();

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
  
  const handleCopy = (view: 'main' | 'subset') => {
    if (status !== 'ready') return;
    setStatus('copying');
    // Use Ref here as well for consistency, although state would work in this context
    workerRef.current?.postMessage({
        type: 'get-full-json',
        jobId: jobIdRef.current,
        payload: { view, selectedLanguages: Array.from(selectedLanguagesRef.current) }
    });
  };

  const handleCopyKeys = () => {
    if (status !== 'ready') return;
    setStatus('copying');
    workerRef.current?.postMessage({
        type: 'get-all-keys',
        jobId: jobIdRef.current
    });
  };

  const handleCopyTranslated = () => {
    if (status !== 'ready') return;
    setStatus('copying');
    workerRef.current?.postMessage({
        type: 'get-translated-json',
        jobId: jobIdRef.current,
        payload: { selectedLanguages: Array.from(selectedLanguagesRef.current) }
    });
  };

  const handleScroll = (view: 'main' | 'subset') => {
    const ref = view === 'main' ? mainPreRef : subsetPreRef;
    const hasMore = view === 'main' ? mainHasMore : subsetHasMore;
    const currentPage = view === 'main' ? mainCurrentPage : subsetCurrentPage;

    if (!ref.current || !hasMore || status !== 'ready') return;

    const { scrollTop, scrollHeight, clientHeight } = ref.current;
    if (scrollHeight - scrollTop < clientHeight * 1.5) {
      requestPage(currentPage + 1, view);
    }
  };

  const handleDragOver = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(true); };
  const handleDragLeave = (e: React.DragEvent<HTMLDivElement>) => { e.preventDefault(); setIsDragging(false); };
  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file && file.type === 'application/json') processFile(file);
    else setError('Invalid file type. Please drop a JSON file.');
  };

  const renderContent = (view: 'main' | 'subset') => {
    if (status === 'loading') return <span className="text-gray-500 flex items-center justify-center h-full">Processing...</span>;
    if (status === 'idle') return <span className="text-gray-500 flex items-center justify-center h-full">Waiting for file...</span>;
    
    if (filteredCount === 0) {
      return <code>[]</code>;
    }
    
    const results = view === 'main' ? mainResults : subsetResults;
    const hasMore = view === 'main' ? mainHasMore : subsetHasMore;

    if (results.length === 0 && status === 'filtering') return <span className="text-gray-500 flex items-center justify-center h-full">Filtering...</span>;

    return (
        <div className="font-mono text-xs sm:text-sm">
            <div className="text-gray-500">{'['}</div>
            {results.map((item, index) => (
                <div key={index} className="flex group hover:bg-gray-700/30 rounded-sm">
                    <div className="select-none text-gray-500 w-10 text-right pr-3 flex-shrink-0 opacity-50 py-0.5" aria-hidden="true">
                        {index + 1}
                    </div>
                    <div className="flex-grow min-w-0">
                        <pre className="whitespace-pre-wrap break-all">{JSON.stringify(item, null, 2)}{index < filteredCount - 1 ? ',' : ''}</pre>
                    </div>
                </div>
            ))}
            {hasMore && <div className="text-gray-500 pl-12 py-2">// Scroll to load more results...</div>}
            <div className="text-gray-500">{']'}</div>
        </div>
    );
  };

  const selectedLangsList = Array.from(selectedLanguages).sort().map(l => getDisplayName(l)).join(', ');
  const selectedLangsSummary = selectedLangsList.length > 50 ? selectedLangsList.substring(0, 50) + '...' : selectedLangsList;

  return (
    <div className="min-h-screen bg-gray-900 text-gray-200 font-sans p-4 sm:p-6 lg:p-8">
      <div className="max-w-7xl mx-auto">
        <header className="mb-8 text-center">
          <h1 className="text-4xl font-bold text-cyan-400">JSON Translation Filter</h1>
          <p className="text-gray-400 mt-2">Upload, search, and manage your multilingual translation files with ease.</p>
        </header>

        <main className="grid grid-cols-1 lg:grid-cols-[400px_1fr] gap-8">
          {/* Controls Column */}
          <div className="flex flex-col gap-6">
             <div className="bg-gray-800 p-6 rounded-lg shadow-lg space-y-6">
                <div>
                    <h2 className="text-xl font-semibold text-white mb-4 border-b border-gray-700 pb-2">Controls</h2>
                    
                    {/* File Upload */}
                    <label className="block text-sm font-medium text-gray-300 mb-2">Upload JSON File</label>
                    <div
                        onDragOver={handleDragOver}
                        onDragLeave={handleDragLeave}
                        onDrop={handleDrop}
                        className={`flex justify-center px-6 pt-5 pb-6 border-2 border-dashed rounded-md transition-colors ${isDragging ? 'border-cyan-400' : 'border-gray-600'}`}
                    >
                        <div className="space-y-1 text-center">
                            <svg className="mx-auto h-10 w-10 text-gray-500" stroke="currentColor" fill="none" viewBox="0 0 48 48"><path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
                            <div className="flex text-sm text-gray-500">
                                <label className={`relative cursor-pointer bg-gray-800 rounded-md font-medium text-cyan-400 hover:text-cyan-300 focus-within:outline-none ${status === 'loading' ? 'opacity-50' : ''}`}>
                                    <span>Upload a file</span>
                                    <input type="file" className="sr-only" accept=".json" onChange={handleFileChange} disabled={status === 'loading'}/>
                                </label>
                                <p className="pl-1">or drag and drop</p>
                            </div>
                            <p className="text-xs text-gray-600">JSON files only</p>
                        </div>
                    </div>
                    {fileName && status !== 'loading' && status !== 'error' && <p className="text-sm text-green-400 mt-2">Loaded: {fileName} ({totalCount} items)</p>}
                    {status === 'loading' && <p className="text-sm text-yellow-400 mt-2">Processing {fileName}...</p>}
                    {error && <p className="text-sm text-red-400 mt-2">{error}</p>}
                </div>

                {/* Search Controls */}
                <div className="space-y-4">
                    <div>
                        <label htmlFor="key-search" className="block text-sm font-medium text-gray-300">Search by Key</label>
                        <input
                            type="text"
                            id="key-search"
                            value={keySearch}
                            onChange={(e) => setKeySearch(e.target.value)}
                            placeholder="e.g., RingCentral.analyticsPortal"
                            className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md py-2 px-3 text-white focus:ring-cyan-500 focus:border-cyan-500 sm:text-sm"
                            disabled={status === 'idle' || status === 'loading'}
                        />
                        <div className="flex flex-wrap gap-x-4 mt-2">
                            <div className="flex items-center">
                                <input
                                    id="match-key-whole-word"
                                    type="checkbox"
                                    checked={matchKeyWholeWord}
                                    onChange={(e) => setMatchKeyWholeWord(e.target.checked)}
                                    className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    disabled={status === 'idle' || status === 'loading'}
                                />
                                <label htmlFor="match-key-whole-word" className="ml-2 block text-sm text-gray-300 select-none cursor-pointer">
                                    Match whole word
                                </label>
                            </div>
                            <div className="flex items-center">
                                <input
                                    id="match-key-case"
                                    type="checkbox"
                                    checked={matchKeyCase}
                                    onChange={(e) => setMatchKeyCase(e.target.checked)}
                                    className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    disabled={status === 'idle' || status === 'loading'}
                                />
                                <label htmlFor="match-key-case" className="ml-2 block text-sm text-gray-300 select-none cursor-pointer">
                                    Match case
                                </label>
                            </div>
                        </div>
                    </div>

                    <div>
                        <label htmlFor="source-search" className="block text-sm font-medium text-gray-300">Search in Source (en-US)</label>
                        <input
                            type="text"
                            id="source-search"
                            value={sourceSearch}
                            onChange={(e) => setSourceSearch(e.target.value)}
                            placeholder="e.g., Hello world"
                            className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md py-2 px-3 text-white focus:ring-cyan-500 focus:border-cyan-500 sm:text-sm"
                            disabled={status === 'idle' || status === 'loading'}
                        />
                        <div className="flex flex-wrap gap-x-4 mt-2">
                            <div className="flex items-center">
                                <input
                                    id="match-source-whole-word"
                                    type="checkbox"
                                    checked={matchSourceWholeWord}
                                    onChange={(e) => setMatchSourceWholeWord(e.target.checked)}
                                    className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    disabled={status === 'idle' || status === 'loading'}
                                />
                                <label htmlFor="match-source-whole-word" className="ml-2 block text-sm text-gray-300 select-none cursor-pointer">
                                    Match whole word
                                </label>
                            </div>
                            <div className="flex items-center">
                                <input
                                    id="match-source-case"
                                    type="checkbox"
                                    checked={matchSourceCase}
                                    onChange={(e) => setMatchSourceCase(e.target.checked)}
                                    className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    disabled={status === 'idle' || status === 'loading'}
                                />
                                <label htmlFor="match-source-case" className="ml-2 block text-sm text-gray-300 select-none cursor-pointer">
                                    Match case
                                </label>
                            </div>
                        </div>
                    </div>
                    <div>
                        <label htmlFor="target-search" className="block text-sm font-medium text-gray-300">Search in Target</label>
                        <input
                            type="text"
                            id="target-search"
                            value={targetSearch}
                            onChange={(e) => setTargetSearch(e.target.value)}
                            placeholder="e.g., Bonjour"
                            className="mt-1 block w-full bg-gray-700 border border-gray-600 rounded-md py-2 px-3 text-white focus:ring-cyan-500 focus:border-cyan-500 sm:text-sm"
                            disabled={status === 'idle' || status === 'loading'}
                        />
                         <div className="flex flex-wrap gap-x-4 mt-2">
                            <div className="flex items-center">
                                <input
                                    id="match-target-whole-word"
                                    type="checkbox"
                                    checked={matchTargetWholeWord}
                                    onChange={(e) => setMatchTargetWholeWord(e.target.checked)}
                                    className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    disabled={status === 'idle' || status === 'loading'}
                                />
                                <label htmlFor="match-target-whole-word" className="ml-2 block text-sm text-gray-300 select-none cursor-pointer">
                                    Match whole word
                                </label>
                            </div>
                            <div className="flex items-center">
                                <input
                                    id="match-target-case"
                                    type="checkbox"
                                    checked={matchTargetCase}
                                    onChange={(e) => setMatchTargetCase(e.target.checked)}
                                    className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    disabled={status === 'idle' || status === 'loading'}
                                />
                                <label htmlFor="match-target-case" className="ml-2 block text-sm text-gray-300 select-none cursor-pointer">
                                    Match case
                                </label>
                            </div>
                        </div>
                    </div>
                </div>

                {/* Language Filter */}
                {availableLanguages.length > 0 && (
                    <div className="border-t border-gray-700 pt-4">
                         <label className="block text-sm font-medium text-gray-300 mb-2">Filter by Language</label>
                         <div className="flex gap-2 mb-2">
                             <button onClick={handleSelectAll} className="text-xs bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition">Select All</button>
                             <button onClick={handleDeselectAll} className="text-xs bg-gray-700 hover:bg-gray-600 text-white py-1 px-3 rounded transition">Deselect All</button>
                         </div>
                         <div className="max-h-60 overflow-y-auto bg-gray-900 rounded border border-gray-700 p-2 custom-scrollbar">
                            {sortedLanguages.map(lang => (
                                <div key={lang} className="flex items-center mb-1.5">
                                    <input
                                        id={`lang-${lang}`}
                                        type="checkbox"
                                        checked={selectedLanguages.has(lang)}
                                        onChange={() => handleLanguageChange(lang)}
                                        className="h-4 w-4 text-cyan-600 focus:ring-cyan-500 border-gray-600 rounded bg-gray-700"
                                    />
                                    <label htmlFor={`lang-${lang}`} className="ml-2 block text-sm text-gray-300 cursor-pointer select-none">
                                        {getDisplayName(lang)}
                                    </label>
                                </div>
                            ))}
                         </div>
                         <p className="text-xs text-gray-500 mt-1">{selectedLanguages.size} languages selected</p>
                    </div>
                )}

                <div className="pt-2">
                    <button
                        onClick={handleApplyFilters}
                        disabled={status === 'idle' || status === 'loading' || status === 'filtering'}
                        className="w-full inline-flex items-center justify-center px-4 py-2 border border-transparent text-base font-medium rounded-md shadow-sm text-white bg-cyan-600 hover:bg-cyan-700 focus:outline-none disabled:bg-gray-600 disabled:cursor-not-allowed transition-colors duration-200"
                    >
                        {status === 'filtering' ? 'Filtering...' : 'Apply Filters'}
                    </button>
                </div>
             </div>
          </div>

          {/* Results Column */}
          <div className="flex flex-col gap-8">
            
            {/* Main Results Panel */}
            <div className="bg-gray-800 rounded-lg shadow-lg flex flex-col h-[400px]">
                <div className="flex justify-between items-center p-4 border-b border-gray-700 bg-gray-800 rounded-t-lg">
                  <h2 className="text-lg font-semibold text-white">Results ({filteredCount})</h2>
                  <button
                    onClick={() => handleCopy('main')}
                    disabled={isMainCopied || status !== 'ready' || mainResults.length === 0}
                    className={`inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded shadow-sm text-white ${
                      isMainCopied ? 'bg-green-600' : 'bg-gray-700 hover:bg-gray-600'
                    } disabled:opacity-50 transition-colors`}
                  >
                    {isMainCopied ? <><CheckIcon className="h-4 w-4 mr-1" /> Copied</> : <><ClipboardIcon className="h-4 w-4 mr-1" /> Copy JSON</>}
                  </button>
                </div>
                <div className="flex-grow overflow-hidden relative">
                  <div 
                    ref={mainPreRef} 
                    onScroll={() => handleScroll('main')} 
                    className="absolute inset-0 overflow-auto bg-gray-900 text-xs sm:text-sm p-4 custom-scrollbar"
                  >
                      {renderContent('main')}
                  </div>
                </div>
            </div>

            {/* Filtered Results Panel */}
            <div className="bg-gray-800 rounded-lg shadow-lg flex flex-col h-[500px]">
                <div className="flex flex-col p-4 border-b border-gray-700 bg-gray-800 rounded-t-lg gap-3">
                  <div className="flex justify-between items-start">
                    <div className="flex flex-col">
                        <h2 className="text-lg font-semibold text-white">Filtered Results ({filteredCount})</h2>
                        {selectedLanguages.size > 0 && <span className="text-xs text-gray-400 block truncate max-w-[300px]">{selectedLangsSummary}</span>}
                    </div>
                    <div className="flex flex-wrap gap-2 justify-end">
                        <button
                            onClick={handleCopyKeys}
                            disabled={isSubsetKeysCopied || status !== 'ready' || subsetResults.length === 0}
                            className={`inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded shadow-sm text-white ${
                            isSubsetKeysCopied ? 'bg-green-600' : 'bg-gray-700 hover:bg-gray-600'
                            } disabled:opacity-50 transition-colors`}
                        >
                            {isSubsetKeysCopied ? <><CheckIcon className="h-4 w-4 mr-1" /> Copied</> : <><ClipboardIcon className="h-4 w-4 mr-1" /> Copy Keys</>}
                        </button>
                        <button
                            onClick={handleCopyTranslated}
                            disabled={isTranslatedCopied || status !== 'ready' || subsetResults.length === 0}
                            className={`inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded shadow-sm text-white ${
                            isTranslatedCopied ? 'bg-green-600' : 'bg-gray-700 hover:bg-gray-600'
                            } disabled:opacity-50 transition-colors`}
                        >
                            {isTranslatedCopied ? <><CheckIcon className="h-4 w-4 mr-1" /> Copied</> : <><ClipboardIcon className="h-4 w-4 mr-1" /> w/ Trans</>}
                        </button>
                        <button
                            onClick={() => handleCopy('subset')}
                            disabled={isSubsetCopied || status !== 'ready' || subsetResults.length === 0}
                            className={`inline-flex items-center px-3 py-1.5 border border-transparent text-xs font-medium rounded shadow-sm text-white ${
                            isSubsetCopied ? 'bg-green-600' : 'bg-cyan-600 hover:bg-cyan-700'
                            } disabled:opacity-50 transition-colors`}
                        >
                            {isSubsetCopied ? <><CheckIcon className="h-4 w-4 mr-1" /> Copied</> : <><ClipboardIcon className="h-4 w-4 mr-1" /> Copy JSON</>}
                        </button>
                    </div>
                  </div>
                  
                  {/* Refine Search Input */}
                  <div className="mt-1">
                      <input 
                          type="text"
                          placeholder="Refine results (search again)..."
                          value={refineQuery}
                          onChange={(e) => handleRefineSearch(e.target.value)}
                          className="w-full bg-gray-900 border border-gray-600 rounded px-3 py-1.5 text-sm text-gray-200 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 placeholder-gray-500"
                          disabled={status === 'idle' || (status !== 'ready' && status !== 'filtering')}
                      />
                  </div>
                </div>
                
                <div className="flex-grow overflow-hidden relative">
                  <div 
                    ref={subsetPreRef} 
                    onScroll={() => handleScroll('subset')} 
                    className="absolute inset-0 overflow-auto bg-gray-900 text-xs sm:text-sm p-4 custom-scrollbar"
                  >
                      {renderContent('subset')}
                  </div>
                </div>
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