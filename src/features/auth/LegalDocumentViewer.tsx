import React, { useEffect, useRef } from 'react';
import { ArrowLeft, ExternalLink, FileText, RefreshCw } from 'lucide-react';
import { isSafeExternalUrl, type LegalDocumentDto } from '../../services/LegalDocumentsService';

interface LegalDocumentViewerProps {
  title: string;
  document: LegalDocumentDto | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  onBack: () => void;
}

function renderSafeMarkdownLines(markdown: string): React.ReactNode[] {
  return markdown
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((rawLine, idx) => {
      const line = rawLine.trim();
      if (!line) {
        return <div key={idx} className="h-2" aria-hidden="true" />;
      }
      if (line.startsWith('### ')) {
        return (
          <h4 key={idx} className="text-sm font-semibold text-white mt-3 mb-1">
            {line.slice(4)}
          </h4>
        );
      }
      if (line.startsWith('## ')) {
        return (
          <h3 key={idx} className="text-base font-semibold text-white mt-4 mb-1.5">
            {line.slice(3)}
          </h3>
        );
      }
      if (line.startsWith('# ')) {
        return (
          <h2 key={idx} className="text-lg font-bold text-white mt-4 mb-2">
            {line.slice(2)}
          </h2>
        );
      }
      if (line.startsWith('- ') || line.startsWith('* ')) {
        return (
          <li key={idx} className="ml-4 list-disc text-sm text-zinc-300 leading-relaxed">
            {line.slice(2)}
          </li>
        );
      }
      return (
        <p key={idx} className="text-sm text-zinc-300 leading-relaxed">
          {line}
        </p>
      );
    });
}

export function LegalDocumentViewer({
  title,
  document,
  loading = false,
  error = null,
  onRetry,
  onBack,
}: LegalDocumentViewerProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    containerRef.current?.focus();
  }, [title]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onBack();
    }
  };

  return (
    <div
      ref={containerRef}
      tabIndex={-1}
      onKeyDown={handleKeyDown}
      role="region"
      aria-label={title}
      className="flex flex-col h-full max-h-[460px] bg-black text-zinc-100 rounded-xl border border-zinc-800 outline-none"
    >
      <div className="flex items-center justify-between gap-3 px-4 py-3 bg-zinc-900/90 border-b border-zinc-800 rounded-t-xl">
        <div className="flex items-center gap-2.5 min-w-0">
          <button
            type="button"
            onClick={onBack}
            className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-zinc-800 hover:bg-zinc-700 text-xs font-medium text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <ArrowLeft className="w-3.5 h-3.5" aria-hidden="true" />
            Voltar
          </button>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-white truncate flex items-center gap-1.5">
              <FileText className="w-4 h-4 text-red-500 shrink-0" aria-hidden="true" />
              <span className="truncate">{title}</span>
            </h3>
            {document && (
              <p className="text-[11px] text-zinc-400 truncate">
                Versão {document.version}
                {document.effective_at
                  ? ` · Vigência: ${new Date(document.effective_at).toLocaleDateString('pt-BR')}`
                  : ''}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-950 rounded-b-xl">
        {loading && (
          <p className="text-sm text-zinc-400">Carregando documento oficial...</p>
        )}

        {!loading && error && (
          <div className="p-3 rounded-lg border border-red-900/60 bg-red-950/30 space-y-2">
            <p className="text-sm text-red-300">{error}</p>
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-500 text-xs font-medium text-white"
              >
                <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />
                Tentar novamente
              </button>
            )}
          </div>
        )}

        {!loading && !error && !document && (
          <div className="p-3 rounded-lg border border-zinc-800 bg-zinc-900/60">
            <p className="text-sm text-zinc-300">
              Este documento ainda não possui versão vigente publicada no servidor.
            </p>
          </div>
        )}

        {!loading && !error && document && (
          <>
            {document.content_markdown ? (
              <div className="space-y-1">{renderSafeMarkdownLines(document.content_markdown)}</div>
            ) : isSafeExternalUrl(document.official_url) ? (
              <a
                href={document.official_url ?? undefined}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 text-sm text-red-400 hover:text-red-300 underline"
              >
                Abrir documento oficial
                <ExternalLink className="w-3.5 h-3.5" aria-hidden="true" />
              </a>
            ) : (
              <p className="text-sm text-zinc-400">Conteúdo oficial indisponível.</p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
