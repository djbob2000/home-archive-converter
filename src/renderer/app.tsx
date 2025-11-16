import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { DragEvent } from 'react';
import { createRoot } from 'react-dom/client';
import * as fs from 'fs';
import * as path from 'path';
import {
  InputItem,
  ProcessingProgress,
  ProcessingRequest,
  ProcessingResult,
  ProcessingSettings
} from '../common/types';

declare global {
  interface Window {
    electron: {
      convert: {
        start: (data: ProcessingRequest) => Promise<{ success: boolean; error?: string }>;
        cancel: () => Promise<void>;
        onProgress: (callback: (progress: ProcessingProgress) => void) => () => void;
        onComplete: (callback: (result: ProcessingResult) => void) => () => void;
        onError: (callback: (error: { message: string }) => void) => () => void;
      };
      dialog: {
        openFiles: () => Promise<string[]>;
        openDirectory: () => Promise<string | null>;
      };
      settings: {
        get: () => Promise<any>;
        save: (settings: any) => Promise<void>;
        reset: () => Promise<void>;
      };
      window: {
        minimize: () => Promise<void>;
        maximize: () => Promise<void>;
        close: () => Promise<void>;
      };
      update: {
        check: () => Promise<void>;
        download: () => Promise<void>;
        install: () => Promise<void>;
        onStatus: (callback: (status: { event: string; data?: any }) => void) => () => void;
      };
    };
  }
}

type TabKey = 'input' | 'output' | 'modify' | 'settings' | 'about';

type FileWithPath = File & { path?: string };

interface InputState {
  items: InputItem[];
  commonBase: string | null;
}

const defaultSettings: ProcessingSettings = {
  output: {
    format: 'jxl',
    quality: 90,
    effort: 7,
    lossless: false,
    keepAlpha: true,
    destination: 'source',
    customDirectory: undefined,
    keepFolderStructure: true,
    renameStrategy: 'skip',
    suffix: ''
  },
  downscale: {
    mode: 'none',
    width: undefined,
    height: undefined,
    value: undefined,
    allowEnlarge: false,
    resampling: 'lanczos3'
  },
  advanced: {
    concurrency: 4,
    preserveMetadata: true,
    preserveTimestamps: true,
    deleteOriginals: false,
    playSoundOnFinish: true,
    soundVolume: 50,
    clearInputAfterConversion: true
  }
};

const generateId = (): string => Math.random().toString(36).substring(2, 10);

const collectFilesRecursively = (directory: string): string[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    console.warn('Skipping directory', directory, error);
    return [];
  }

  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFilesRecursively(fullPath));
    } else {
      files.push(fullPath);
    }
  }

  return files;
};

const expandFilePaths = (pathsToExpand: string[]): string[] => {
  const result: string[] = [];

  for (const entry of pathsToExpand) {
    try {
      const stats = fs.statSync(entry);
      if (stats.isDirectory()) {
        result.push(...collectFilesRecursively(entry));
      } else {
        result.push(entry);
      }
    } catch (error) {
      console.warn('Skipping path', entry, error);
    }
  }

  return result;
};

const getCommonBase = (a: string, b: string): string => {
  const partsA = a.split(path.sep).filter(Boolean);
  const partsB = b.split(path.sep).filter(Boolean);
  const length = Math.min(partsA.length, partsB.length);
  const common: string[] = [];

  for (let i = 0; i < length; i += 1) {
    if (partsA[i] === partsB[i]) {
      common.push(partsA[i]);
    } else {
      break;
    }
  }

  if (common.length === 0) {
    return process.platform === 'win32' ? path.parse(a).root : '/';
  }

  const root = path.parse(a).root;
  return path.join(root, ...common);
};

const applyRelativePaths = (items: InputItem[], base: string | null): InputItem[] => {
  if (items.length === 0) {
    return [];
  }

  if (!base) {
    return items.map((item) => ({
      ...item,
      relativePath: path.basename(item.sourcePath)
    }));
  }

  return items.map((item) => ({
    ...item,
    relativePath: path.relative(base, item.sourcePath)
  }));
};

const formatSize = (bytes: number): string => {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const size = bytes / 1024 ** index;
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
};

const playNotification = (volume: number): void => {
  try {
    const audioContext = new AudioContext();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800;
    oscillator.type = 'sine';

    const gain = Math.max(0, Math.min(1, volume / 100));
    gainNode.gain.value = gain * 0.3;

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
    oscillator.onended = () => {
      audioContext.close().catch(() => undefined);
    };
  } catch (error) {
    console.warn('Failed to play notification sound', error);
  }
};

const mergeSettings = (base: ProcessingSettings, incoming?: Partial<ProcessingSettings>): ProcessingSettings => ({
  output: {
    ...base.output,
    ...(incoming?.output ?? {})
  },
  downscale: {
    ...base.downscale,
    ...(incoming?.downscale ?? {})
  },
  advanced: {
    ...base.advanced,
    ...(incoming?.advanced ?? {})
  }
});

const App = () => {
  const [activeTab, setActiveTab] = useState<TabKey>('input');
  const [inputState, setInputState] = useState<InputState>({ items: [], commonBase: null });
  const [settings, setSettings] = useState<ProcessingSettings>(defaultSettings);
  const [isProgressOpen, setProgressOpen] = useState(false);
  const [progress, setProgress] = useState<ProcessingProgress>({ completed: 0, total: 0 });
  const [initializingSettings, setInitializingSettings] = useState(true);

  const settingsRef = useRef(settings);
  const hasHydratedSettings = useRef(false);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const addFiles = useCallback(async (pathsToAdd: string[]) => {
    if (pathsToAdd.length === 0) {
      return;
    }

    const expandedPaths = expandFilePaths(pathsToAdd);
    if (expandedPaths.length === 0) {
      return;
    }

    setInputState((prev) => {
      let base = prev.commonBase;
      const existingPaths = new Set(prev.items.map((item) => item.sourcePath));
      const nextItems = [...prev.items];
      let added = false;

      for (const filePath of expandedPaths) {
        if (existingPaths.has(filePath)) {
          continue;
        }

        let stats: fs.Stats;
        try {
          stats = fs.statSync(filePath);
        } catch (error) {
          console.warn('Skipping file', filePath, error);
          continue;
        }

        if (stats.isDirectory()) {
          continue;
        }

        const parentDir = path.dirname(filePath);
        base = base ? getCommonBase(base, parentDir) : parentDir;

        nextItems.push({
          id: generateId(),
          sourcePath: filePath,
          displayName: path.basename(filePath),
          relativePath: '',
          sizeBytes: stats.size,
          lastModified: stats.mtime.getTime()
        });
        added = true;
      }

      if (!added) {
        return prev;
      }

      const resolvedBase = nextItems.length === 0 ? null : base;
      return {
        items: applyRelativePaths(nextItems, resolvedBase ?? null),
        commonBase: resolvedBase ?? null
      };
    });
  }, []);

  const removeItem = useCallback((id: string) => {
    setInputState((prev) => {
      const items = prev.items.filter((item) => item.id !== id);
      const commonBase = items.length === 0 ? null : prev.commonBase;
      return {
        items: applyRelativePaths(items, commonBase),
        commonBase
      };
    });
  }, []);

  const clearItems = useCallback(() => {
    setInputState({ items: [], commonBase: null });
  }, []);

  const startConversion = useCallback(async () => {
    if (inputState.items.length === 0) {
      window.alert('Add files before starting conversion.');
      return;
    }

    const request: ProcessingRequest = {
      items: inputState.items,
      settings
    };

    setProgressOpen(true);
    setProgress({ completed: 0, total: inputState.items.length });

    try {
      const response = await window.electron.convert.start(request);
      if (!response.success && response.error) {
        setProgressOpen(false);
        window.alert(response.error);
      }
    } catch (error) {
      setProgressOpen(false);
      const message = error instanceof Error ? error.message : 'Failed to start conversion.';
      window.alert(message);
    }
  }, [inputState.items, settings]);

  const handleConversionComplete = useCallback((result: ProcessingResult) => {
    setProgressOpen(false);

    if (result.canceled) {
      window.alert('Conversion was canceled.');
      return;
    }

    const activeSettings = settingsRef.current;

    if (activeSettings.advanced.playSoundOnFinish) {
      playNotification(activeSettings.advanced.soundVolume);
    }

    const messageLines = [
      'Conversion finished!',
      `Successful: ${result.successCount}`,
      `Skipped: ${result.skippedCount}`,
      `Failed: ${result.failedCount}`
    ];

    if (result.errors.length > 0) {
      messageLines.push('', 'Errors:');
      result.errors.slice(0, 5).forEach((entry) => {
        messageLines.push(`• ${entry.item.displayName}: ${entry.error}`);
      });
      if (result.errors.length > 5) {
        messageLines.push(`...and ${result.errors.length - 5} more`);
      }
    }

    window.alert(messageLines.join('\n'));

    if (activeSettings.advanced.clearInputAfterConversion && result.successCount > 0) {
      setInputState({ items: [], commonBase: null });
    }
  }, []);

  useEffect(() => {
    let mounted = true;

    const loadSettings = async () => {
      try {
        const stored = await window.electron.settings.get();
        if (!mounted) {
          return;
        }

        if (stored) {
          setSettings((prev) => mergeSettings(prev, stored));
        }
      } catch (error) {
        console.error('Failed to load settings', error);
      } finally {
        if (mounted) {
          setInitializingSettings(false);
        }
      }
    };

    loadSettings();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (initializingSettings) {
      return;
    }

    if (!hasHydratedSettings.current) {
      hasHydratedSettings.current = true;
      return;
    }

    const timeout = setTimeout(() => {
      window.electron.settings.save(settings).catch((error) => {
        console.error('Failed to save settings', error);
      });
    }, 500);

    return () => clearTimeout(timeout);
  }, [settings, initializingSettings]);

  useEffect(() => {
    const unsubscribeProgress = window.electron.convert.onProgress((update) => {
      setProgress(update);
    });

    const unsubscribeComplete = window.electron.convert.onComplete((result) => {
      handleConversionComplete(result);
    });

    const unsubscribeError = window.electron.convert.onError((error) => {
      setProgressOpen(false);
      window.alert(error.message);
    });

    return () => {
      unsubscribeProgress?.();
      unsubscribeComplete?.();
      unsubscribeError?.();
    };
  }, [handleConversionComplete]);

  useEffect(() => {
    const unsubscribe = window.electron.update.onStatus((status) => {
      switch (status.event) {
        case 'update-available':
          if (status.data?.version && window.confirm(`New version ${status.data.version} is available. Download now?`)) {
            window.electron.update.download().catch((error) => {
              console.error('Failed to start update download', error);
            });
          }
          break;
        case 'update-downloaded':
          if (window.confirm('Update downloaded. Restart to install?')) {
            window.electron.update.install().catch((error) => {
              console.error('Failed to install update', error);
            });
          }
          break;
        case 'download-progress':
          if (status.data?.percent !== undefined) {
            console.log(`Download progress: ${Math.round(status.data.percent)}%`);
          }
          break;
        case 'update-error':
          if (status.data?.message) {
            console.error('Update error:', status.data.message);
          }
          break;
        default:
          break;
      }
    });

    return () => {
      unsubscribe?.();
    };
  }, []);

  const updateOutputSetting = useCallback(
    <K extends keyof ProcessingSettings['output']>(key: K, value: ProcessingSettings['output'][K]) => {
      setSettings((prev) => ({
        ...prev,
        output: {
          ...prev.output,
          [key]: value
        }
      }));
    },
    []
  );

  const updateDownscaleSetting = useCallback(
    <K extends keyof ProcessingSettings['downscale']>(key: K, value: ProcessingSettings['downscale'][K]) => {
      setSettings((prev) => ({
        ...prev,
        downscale: {
          ...prev.downscale,
          [key]: value
        }
      }));
    },
    []
  );

  const updateAdvancedSetting = useCallback(
    <K extends keyof ProcessingSettings['advanced']>(key: K, value: ProcessingSettings['advanced'][K]) => {
      setSettings((prev) => ({
        ...prev,
        advanced: {
          ...prev.advanced,
          [key]: value
        }
      }));
    },
    []
  );

  const progressPercentage = useMemo(() => {
    if (progress.total === 0) {
      return 0;
    }
    return Math.min(100, (progress.completed / progress.total) * 100);
  }, [progress.completed, progress.total]);

  const progressStatus = progress.message
    ? progress.message
    : progress.currentItem
    ? `Processing ${progress.currentItem.displayName}`
    : '';

  const tabs: { id: TabKey; label: string }[] = useMemo(
    () => [
      { id: 'input', label: 'Input' },
      { id: 'output', label: 'Output' },
      { id: 'modify', label: 'Modify' },
      { id: 'settings', label: 'Settings' },
      { id: 'about', label: 'About' }
    ],
    []
  );

  return (
    <div className="flex h-full flex-col font-sans">
      <Titlebar />

      <div className="flex flex-col overflow-hidden">
        <nav className="flex border-b border-slate-200 bg-white px-2">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`relative cursor-pointer border-b-2 px-4 py-3 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 ${
                activeTab === tab.id
                  ? 'border-blue-600 text-blue-600'
                  : 'border-transparent text-slate-500 hover:text-slate-700'
              }`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </nav>

        <main className="flex-1 overflow-y-auto bg-slate-100">
          {activeTab === 'input' && (
            <InputTab
              items={inputState.items}
              onAddFiles={addFiles}
              onClear={clearItems}
              onRemove={removeItem}
              onStartConversion={startConversion}
            />
          )}
          {activeTab === 'output' && (
            <OutputTab
              settings={settings.output}
              onChange={updateOutputSetting}
              onStartConversion={startConversion}
            />
          )}
          {activeTab === 'modify' && (
            <ModifyTab
              settings={settings}
              onDownscaleChange={updateDownscaleSetting}
              onStartConversion={startConversion}
            />
          )}
          {activeTab === 'settings' && (
            <SettingsTab settings={settings.advanced} onChange={updateAdvancedSetting} />
          )}
          {activeTab === 'about' && <AboutTab />}
        </main>
      </div>

      <ProgressModal
        isOpen={isProgressOpen}
        progress={progress}
        onCancel={() => window.electron.convert.cancel()}
        percentage={progressPercentage}
        status={progressStatus}
      />
    </div>
  );
};

type InputTabProps = {
  items: InputItem[];
  onAddFiles: (paths: string[]) => Promise<void> | void;
  onClear: () => void;
  onRemove: (id: string) => void;
  onStartConversion: () => void;
};

const InputTab = ({ items, onAddFiles, onClear, onRemove, onStartConversion }: InputTabProps) => {
  const [isDragOver, setDragOver] = useState(false);

  const handleDrop = useCallback(
    async (event: DragEvent<HTMLDivElement>) => {
      event.preventDefault();
      setDragOver(false);

      const files = Array.from(event.dataTransfer?.files ?? []);
      const paths = files
        .map((file) => (file as FileWithPath).path)
        .filter((filePath): filePath is string => Boolean(filePath));

      await onAddFiles(paths);
    },
    [onAddFiles]
  );

  const handleBrowse = useCallback(async () => {
    const paths = await window.electron.dialog.openFiles();
    await onAddFiles(paths);
  }, [onAddFiles]);

  return (
    <div className="mx-auto flex h-full w-full max-w-5xl flex-col gap-6 px-4 py-6">
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={`flex flex-col items-center justify-center gap-4 rounded-xl border-2 border-dashed border-slate-300 bg-white p-12 text-center transition-all ${
          isDragOver ? 'border-blue-500 bg-blue-50 text-blue-600' : 'text-slate-500'
        }`}
      >
        <svg className="h-16 w-16" fill="currentColor" viewBox="0 0 24 24">
          <path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z" />
        </svg>
        <div className="text-lg font-medium text-slate-700">Drop files here or click to browse</div>
        <button
          type="button"
          onClick={handleBrowse}
          className="button-primary rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          Add Files
        </button>
      </div>

      <div className="grid flex-1 gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="flex h-full flex-col overflow-hidden rounded-xl bg-white shadow-sm">
          <div className="border-b border-slate-200 px-5 py-4 text-sm font-semibold text-slate-700">
            Files ({items.length})
          </div>
          <div className="flex-1 overflow-y-auto">
            {items.length === 0 ? (
              <div className="flex h-full items-center justify-center p-8 text-sm text-slate-400">
                No files added yet
              </div>
            ) : (
              <ul className="divide-y divide-slate-200">
                {items.map((item) => (
                  <li key={item.id} className="flex items-center justify-between gap-4 px-5 py-3 text-sm">
                    <div className="min-w-0">
                      <div className="truncate font-medium text-slate-700">{item.displayName}</div>
                      <div className="truncate text-xs text-slate-400">
                        {item.relativePath} — {formatSize(item.sizeBytes)}
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => onRemove(item.id)}
                      className="button-secondary rounded-md px-3 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-50"
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        <div className="hidden rounded-xl border border-dashed border-slate-200 bg-white/60 p-6 text-center text-sm text-slate-400 lg:flex lg:flex-col lg:items-center lg:justify-center">
          <svg className="mb-4 h-12 w-12 text-slate-300" fill="none" stroke="currentColor" strokeWidth="1.5" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" d="M3 16.5v-9a1.5 1.5 0 0 1 1.5-1.5h4.379a1.5 1.5 0 0 1 1.06.44l1.121 1.12a1.5 1.5 0 0 0 1.061.44h6.379A1.5 1.5 0 0 1 20.5 9v7.5A1.5 1.5 0 0 1 19 18H4.5A1.5 1.5 0 0 1 3 16.5Z" />
          </svg>
          <div className="font-medium text-slate-500">Preview</div>
          <p className="mt-2 max-w-[14rem] text-xs text-slate-400">
            Select a file to view its details here in a future update.
          </p>
        </div>
      </div>

      <div className="flex justify-end gap-3">
        <button
          type="button"
          onClick={onClear}
          disabled={items.length === 0}
          className="button-secondary rounded-lg bg-slate-200 px-5 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:bg-slate-200 disabled:text-slate-400"
        >
          Clear
        </button>
        <button
          type="button"
          onClick={onStartConversion}
          disabled={items.length === 0}
          className="button-primary rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:bg-blue-300"
        >
          Convert
        </button>
      </div>
    </div>
  );
};

type OutputTabProps = {
  settings: ProcessingSettings['output'];
  onChange: <K extends keyof ProcessingSettings['output']>(key: K, value: ProcessingSettings['output'][K]) => void;
  onStartConversion: () => void;
};

const OutputTab = ({ settings, onChange, onStartConversion }: OutputTabProps) => {
  const handleDestinationChange = (value: 'source' | 'custom') => {
    onChange('destination', value);
    if (value === 'source') {
      onChange('customDirectory', undefined);
    }
  };

  const browseDirectory = async () => {
    const directory = await window.electron.dialog.openDirectory();
    if (directory) {
      onChange('customDirectory', directory);
      onChange('destination', 'custom');
    }
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h3 className="text-base font-semibold text-slate-700">Output Format</h3>
        <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-2">
          {[
            { label: 'JPEG XL', value: 'jxl' },
            { label: 'AVIF', value: 'avif' },
            { label: 'WebP', value: 'webp' },
            { label: 'JPEG', value: 'jpeg' },
            { label: 'PNG', value: 'png' }
          ].map((option) => (
            <label key={option.value} className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3">
              <input
                type="radio"
                className="h-4 w-4 text-blue-600 focus:ring-blue-500"
                name="format"
                value={option.value}
                checked={settings.format === option.value}
                onChange={() => onChange('format', option.value as ProcessingSettings['output']['format'])}
              />
              {option.label}
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <h3 className="text-base font-semibold text-slate-700">Quality</h3>
            <p className="text-sm text-slate-500">Adjust compression quality (1-100).</p>
          </div>
          <div className="flex w-full max-w-md items-center gap-4">
            <input
              type="range"
              min={1}
              max={100}
              value={settings.quality}
              onChange={(event) => onChange('quality', Number(event.target.value))}
              className="range-input"
            />
            <span className="w-12 text-right text-sm font-semibold text-slate-700">{settings.quality}</span>
          </div>
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
          <div className="flex-1">
            <h3 className="text-base font-semibold text-slate-700">Effort</h3>
            <p className="text-sm text-slate-500">Encoding speed vs. compression efficiency (1-9).</p>
          </div>
          <div className="flex w-full max-w-md items-center gap-4">
            <input
              type="range"
              min={1}
              max={9}
              value={settings.effort}
              onChange={(event) => onChange('effort', Number(event.target.value))}
              className="range-input"
            />
            <span className="w-12 text-right text-sm font-semibold text-slate-700">{settings.effort}</span>
          </div>
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <div className="flex flex-col gap-3 text-sm text-slate-600">
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.lossless}
              onChange={(event) => onChange('lossless', event.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            Lossless
          </label>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.keepAlpha}
              onChange={(event) => onChange('keepAlpha', event.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            Keep Alpha Channel
          </label>
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h3 className="text-base font-semibold text-slate-700">Destination</h3>
        <div className="mt-4 flex flex-col gap-3 text-sm text-slate-600">
          <label className="flex items-center gap-3">
            <input
              type="radio"
              name="destination"
              value="source"
              checked={settings.destination === 'source'}
              onChange={() => handleDestinationChange('source')}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            Same as source
          </label>
          <label className="flex items-center gap-3">
            <input
              type="radio"
              name="destination"
              value="custom"
              checked={settings.destination === 'custom'}
              onChange={() => handleDestinationChange('custom')}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            Custom directory
          </label>
          <div className="flex flex-col gap-3 sm:flex-row">
            <input
              type="text"
              value={settings.customDirectory ?? ''}
              onChange={(event) => onChange('customDirectory', event.target.value || undefined)}
              disabled={settings.destination !== 'custom'}
              placeholder="Select directory..."
              className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:bg-slate-100"
            />
            <button
              type="button"
              onClick={browseDirectory}
              disabled={settings.destination !== 'custom'}
              className="button-secondary rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-600 transition hover:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2 disabled:bg-slate-200 disabled:text-slate-400"
            >
              Browse
            </button>
          </div>
          <label className="flex items-center gap-3">
            <input
              type="checkbox"
              checked={settings.keepFolderStructure}
              onChange={(event) => onChange('keepFolderStructure', event.target.checked)}
              className="h-4 w-4 text-blue-600 focus:ring-blue-500"
            />
            Keep folder structure
          </label>
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <h3 className="text-base font-semibold text-slate-700">Rename Strategy</h3>
        <div className="mt-4 grid gap-2 text-sm text-slate-600 sm:grid-cols-3">
          {[
            { label: 'Overwrite existing', value: 'overwrite' },
            { label: 'Skip existing', value: 'skip' },
            { label: 'Rename duplicates', value: 'rename' }
          ].map((option) => (
            <label key={option.value} className="flex items-center gap-3 rounded-lg border border-slate-200 px-4 py-3">
              <input
                type="radio"
                name="rename"
                value={option.value}
                checked={settings.renameStrategy === option.value}
                onChange={() =>
                  onChange('renameStrategy', option.value as ProcessingSettings['output']['renameStrategy'])
                }
                className="h-4 w-4 text-blue-600 focus:ring-blue-500"
              />
              {option.label}
            </label>
          ))}
        </div>
      </section>

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <label className="flex flex-col gap-2 text-sm text-slate-600">
          <span className="text-base font-semibold text-slate-700">Suffix</span>
          <input
            type="text"
            value={settings.suffix}
            onChange={(event) => onChange('suffix', event.target.value)}
            placeholder="e.g., _converted"
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
        </label>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onStartConversion}
          className="button-primary rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          Convert
        </button>
      </div>
    </div>
  );
};

type ModifyTabProps = {
  settings: ProcessingSettings;
  onDownscaleChange: <K extends keyof ProcessingSettings['downscale']>(
    key: K,
    value: ProcessingSettings['downscale'][K]
  ) => void;
  onStartConversion: () => void;
};

const ModifyTab = ({ settings, onDownscaleChange, onStartConversion }: ModifyTabProps) => {
  const { downscale } = settings;

  const showDimensions = downscale.mode === 'dimensions';
  const showValue = ['percentage', 'longer-side', 'shorter-side', 'megapixels'].includes(downscale.mode);

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
      <section className="rounded-xl bg-white p-6 shadow-sm">
        <label className="flex flex-col gap-2 text-sm text-slate-600">
          <span className="text-base font-semibold text-slate-700">Downscale Mode</span>
          <select
            value={downscale.mode}
            onChange={(event) => onDownscaleChange('mode', event.target.value as typeof downscale.mode)}
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="none">None</option>
            <option value="dimensions">Dimensions</option>
            <option value="percentage">Percentage</option>
            <option value="longer-side">Longer Side</option>
            <option value="shorter-side">Shorter Side</option>
            <option value="megapixels">Megapixels</option>
          </select>
        </label>
      </section>

      {(showDimensions || showValue) && (
        <section className="rounded-xl bg-white p-6 shadow-sm">
          <div className="flex flex-col gap-4 text-sm text-slate-600">
            {showDimensions && (
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-slate-700">Width</span>
                  <input
                    type="number"
                    min={1}
                    value={downscale.width ?? ''}
                    onChange={(event) =>
                      onDownscaleChange('width', event.target.value ? Number(event.target.value) : undefined)
                    }
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="font-medium text-slate-700">Height</span>
                  <input
                    type="number"
                    min={1}
                    value={downscale.height ?? ''}
                    onChange={(event) =>
                      onDownscaleChange('height', event.target.value ? Number(event.target.value) : undefined)
                    }
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </label>
              </div>
            )}

            {showValue && (
              <label className="flex flex-col gap-1">
                <span className="font-medium text-slate-700">Value</span>
                <input
                  type="number"
                  min={1}
                  value={downscale.value ?? ''}
                  onChange={(event) =>
                    onDownscaleChange('value', event.target.value ? Number(event.target.value) : undefined)
                  }
                  className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
              </label>
            )}

            <label className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={downscale.allowEnlarge}
                onChange={(event) => onDownscaleChange('allowEnlarge', event.target.checked)}
                className="h-4 w-4 text-blue-600 focus:ring-blue-500"
              />
              Allow enlarge
            </label>
          </div>
        </section>
      )}

      <section className="rounded-xl bg-white p-6 shadow-sm">
        <label className="flex flex-col gap-2 text-sm text-slate-600">
          <span className="text-base font-semibold text-slate-700">Resampling</span>
          <select
            value={downscale.resampling}
            onChange={(event) =>
              onDownscaleChange('resampling', event.target.value as typeof downscale.resampling)
            }
            className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          >
            <option value="lanczos3">Lanczos3</option>
            <option value="catmullRom">Catmull-Rom</option>
            <option value="mitchell">Mitchell</option>
            <option value="nearest">Nearest</option>
          </select>
        </label>
      </section>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={onStartConversion}
          className="button-primary rounded-lg bg-blue-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-blue-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          Convert
        </button>
      </div>
    </div>
  );
};

type SettingsTabProps = {
  settings: ProcessingSettings['advanced'];
  onChange: <K extends keyof ProcessingSettings['advanced']>(key: K, value: ProcessingSettings['advanced'][K]) => void;
};

const SettingsTab = ({ settings, onChange }: SettingsTabProps) => (
  <div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
    <section className="rounded-xl bg-white p-6 shadow-sm">
      <label className="flex flex-col gap-2 text-sm text-slate-600">
        <span className="text-base font-semibold text-slate-700">Concurrency</span>
        <input
          type="number"
          min={1}
          max={32}
          value={settings.concurrency}
          onChange={(event) => onChange('concurrency', Math.max(1, Number(event.target.value) || 1))}
          className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </label>
    </section>

    <section className="rounded-xl bg-white p-6 shadow-sm">
      <h3 className="text-base font-semibold text-slate-700">Metadata</h3>
      <div className="mt-3 flex flex-col gap-3 text-sm text-slate-600">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.preserveMetadata}
            onChange={(event) => onChange('preserveMetadata', event.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500"
          />
          Preserve metadata
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.preserveTimestamps}
            onChange={(event) => onChange('preserveTimestamps', event.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500"
          />
          Preserve timestamps
        </label>
      </div>
    </section>

    <section className="rounded-xl bg-white p-6 shadow-sm">
      <h3 className="text-base font-semibold text-slate-700">After Conversion</h3>
      <div className="mt-3 flex flex-col gap-3 text-sm text-slate-600">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.deleteOriginals}
            onChange={(event) => onChange('deleteOriginals', event.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500"
          />
          Delete originals
        </label>
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.clearInputAfterConversion}
            onChange={(event) => onChange('clearInputAfterConversion', event.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500"
          />
          Clear input list
        </label>
      </div>
    </section>

    <section className="rounded-xl bg-white p-6 shadow-sm">
      <h3 className="text-base font-semibold text-slate-700">Sound</h3>
      <div className="mt-3 flex flex-col gap-4 text-sm text-slate-600">
        <label className="flex items-center gap-3">
          <input
            type="checkbox"
            checked={settings.playSoundOnFinish}
            onChange={(event) => onChange('playSoundOnFinish', event.target.checked)}
            className="h-4 w-4 text-blue-600 focus:ring-blue-500"
          />
          Play sound on finish
        </label>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <span className="font-medium text-slate-700">Volume</span>
          <div className="flex w-full max-w-md items-center gap-4">
            <input
              type="range"
              min={0}
              max={100}
              value={settings.soundVolume}
              onChange={(event) => onChange('soundVolume', Number(event.target.value))}
              className="range-input"
            />
            <span className="w-12 text-right text-sm font-semibold text-slate-700">{settings.soundVolume}</span>
          </div>
        </div>
      </div>
    </section>
  </div>
);

const AboutTab = () => (
  <div className="mx-auto w-full max-w-3xl px-4 py-6">
    <div className="rounded-xl bg-white p-8 shadow-sm">
      <h2 className="text-2xl font-semibold text-blue-600">XL Converter</h2>
      <p className="mt-2 text-sm text-slate-500">Version 1.0.0</p>
      <p className="mt-4 text-base text-slate-600">
        Easy-to-use image converter for modern formats.
      </p>

      <h3 className="mt-8 text-lg font-semibold text-slate-700">Features</h3>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-600">
        <li>Support for JPEG XL, AVIF, WebP, JPEG, PNG formats</li>
        <li>Parallel encoding for faster processing</li>
        <li>Lossless JPEG transcoding</li>
        <li>Flexible downscaling options</li>
        <li>Metadata and timestamp preservation</li>
      </ul>

      <h3 className="mt-8 text-lg font-semibold text-slate-700">External Tools</h3>
      <p className="mt-2 text-sm text-slate-600">This application uses the following external encoders:</p>
      <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-slate-600">
        <li>libjxl (JPEG XL)</li>
        <li>avifenc (AVIF)</li>
        <li>cwebp (WebP)</li>
        <li>jpegli (JPEG)</li>
        <li>ImageMagick (downscaling and PNG)</li>
        <li>ExifTool (metadata)</li>
      </ul>
    </div>
  </div>
);

type ProgressModalProps = {
  isOpen: boolean;
  progress: ProcessingProgress;
  percentage: number;
  status: string;
  onCancel: () => Promise<void> | void;
};

const ProgressModal = ({ isOpen, progress, percentage, status, onCancel }: ProgressModalProps) => {
  if (!isOpen) {
    return null;
  }

  const normalizedCompleted = Math.min(progress.completed, progress.total);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 backdrop-blur-sm">
      <div className="w-full max-w-md rounded-xl bg-white p-6 shadow-xl">
        <h3 className="text-lg font-semibold text-slate-700">Converting...</h3>
        <div className="mt-4 h-6 w-full overflow-hidden rounded-full bg-slate-200">
          <div
            className="h-full rounded-full bg-gradient-to-r from-blue-600 to-blue-500 transition-all"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <p className="mt-3 text-center text-sm font-semibold text-slate-700">
          {normalizedCompleted} / {progress.total}
        </p>
        {status && <p className="mt-1 truncate text-center text-xs text-slate-500">{status}</p>}
        <button
          type="button"
          onClick={onCancel}
          className="button-secondary mt-6 w-full rounded-lg bg-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
        >
          Cancel
        </button>
      </div>
    </div>
  );
};

const Titlebar = () => (
  <header className="titlebar">
    <div className="titlebar-title">
      <img src="../assets/icons/logo.svg" alt="XL Converter" className="titlebar-icon" />
      <span>XL Converter</span>
    </div>
    <div className="titlebar-controls">
      <button
        type="button"
        className="titlebar-button minimize"
        onClick={() => {
          window.electron.window.minimize();
        }}
        aria-label="Minimize"
      >
        <svg viewBox="0 0 10 10">
          <path d="M1 5h8" stroke="currentColor" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        className="titlebar-button maximize"
        onClick={() => {
          window.electron.window.maximize();
        }}
        aria-label="Maximize"
      >
        <svg viewBox="0 0 10 10">
          <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" fill="none" />
        </svg>
      </button>
      <button
        type="button"
        className="titlebar-button close"
        onClick={() => {
          window.electron.window.close();
        }}
        aria-label="Close"
      >
        <svg viewBox="0 0 10 10">
          <path d="M2 2l6 6M8 2l-6 6" stroke="currentColor" fill="none" />
        </svg>
      </button>
    </div>
  </header>
);

const container = document.getElementById('root');

if (container) {
  const root = createRoot(container);
  root.render(<App />);
}
