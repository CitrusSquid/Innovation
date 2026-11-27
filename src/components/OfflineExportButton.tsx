import React, { useState } from 'react';
import { Check, Download, Loader2 } from 'lucide-react';
import { downloadOfflineHtml } from '../utils/offlineExport';

export const OfflineExportButton: React.FC<{ compact?: boolean; className?: string }> = ({
  compact = false,
  className = '',
}) => {
  const [status, setStatus] = useState<'idle' | 'building' | 'done' | 'error'>('idle');

  const handleDownload = async () => {
    if (status === 'building') return;
    setStatus('building');
    try {
      await downloadOfflineHtml();
      setStatus('done');
      window.setTimeout(() => setStatus('idle'), 2200);
    } catch {
      setStatus('error');
      window.setTimeout(() => setStatus('idle'), 2500);
    }
  };

  return (
    <button
      type="button"
      onClick={handleDownload}
      disabled={status === 'building'}
      title="Download a single all-in-one .html file you can share and play completely offline"
      aria-label="Save Offline HTML"
      className={`inline-flex items-center justify-center gap-2 cursor-pointer whitespace-nowrap shrink-0 transition-colors ${
        compact
          ? 'min-h-[38px] lg:min-h-[32px] px-2.5 rounded-md border border-[#D9C7A3]/25 bg-[#1C1714] text-xs font-medium text-[#F5EFE2] hover:border-[#F6C945] disabled:opacity-60'
          : 'min-h-[40px] px-3 py-1.5 rounded-lg border border-[#D9C7A3]/25 bg-[#1C1714] text-sm font-semibold text-[#F5EFE2] hover:border-[#F6C945] disabled:opacity-60'
      } ${className}`}
    >
      {status === 'building' ? (
        <Loader2 className="w-4 h-4 animate-spin text-[#F6C945]" />
      ) : status === 'done' ? (
        <Check className="w-4 h-4 text-[#7AE582]" />
      ) : (
        <Download className="w-4 h-4 text-[#F6C945]" />
      )}
      <span>
        {status === 'building'
          ? 'Bundling…'
          : status === 'done'
          ? 'Saved HTML'
          : status === 'error'
          ? 'Retry HTML'
          : compact
          ? 'Save HTML'
          : 'Save Offline HTML'}
      </span>
    </button>
  );
};
