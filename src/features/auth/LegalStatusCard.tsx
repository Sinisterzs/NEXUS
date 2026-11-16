import { useEffect, useState } from 'react';
import { FileText, Shield } from 'lucide-react';
import {
  legalDocumentsService,
  type DocumentComplianceStatus,
  type LegalDocumentDto,
  type LegalDocumentType,
  type LegalStatusResponse,
} from '../../services/LegalDocumentsService';
import { LegalDocumentViewer } from './LegalDocumentViewer';

interface LegalStatusCardProps {
  backendUrl: string;
  sessionToken: string | null;
}

function statusLabel(status: DocumentComplianceStatus): string {
  switch (status) {
    case 'accepted':
      return 'Aceito';
    case 'pending':
      return 'Pendente';
    case 'outdated':
      return 'Nova versão disponível';
    case 'unavailable':
      return 'Indisponível';
  }
}

export function LegalStatusCard({ backendUrl, sessionToken }: LegalStatusCardProps) {
  const [status, setStatus] = useState<LegalStatusResponse | null>(null);
  const [documents, setDocuments] = useState<LegalDocumentDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeDoc, setActiveDoc] = useState<LegalDocumentType | null>(null);

  useEffect(() => {
    if (!sessionToken || !backendUrl) return;
    const controller = new AbortController();
    setLoading(true);

    Promise.allSettled([
      legalDocumentsService.fetchLegalStatus(backendUrl, sessionToken, controller.signal),
      legalDocumentsService.fetchCurrentDocuments(backendUrl, controller.signal),
    ])
      .then(([statusRes, docsRes]) => {
        if (controller.signal.aborted) return;
        if (statusRes.status === 'fulfilled') setStatus(statusRes.value);
        if (docsRes.status === 'fulfilled') setDocuments(docsRes.value.documents);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [backendUrl, sessionToken]);

  if (activeDoc) {
    const doc = documents.find((d) => d.doc_type === activeDoc) ?? null;
    const title = activeDoc === 'terms_of_use' ? 'Termos de Uso' : 'Política de Privacidade';
    return (
      <LegalDocumentViewer
        title={title}
        document={doc}
        onBack={() => setActiveDoc(null)}
      />
    );
  }

  return (
    <div className="rounded-xl border border-zinc-800 bg-zinc-950/80 p-4 space-y-3 text-sm text-zinc-200">
      <div className="flex items-center gap-2">
        <Shield className="w-4 h-4 text-red-500" aria-hidden="true" />
        <h3 className="font-semibold text-white">Documentos Legais e Privacidade</h3>
      </div>

      {loading && <p className="text-xs text-zinc-400">Consultando status legal...</p>}

      {!loading && !status && (
        <p className="text-xs text-zinc-400">
          Status legal indisponível no momento. O uso do NEXUS continua normalmente.
        </p>
      )}

      {!loading && status && (
        <div className="space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Termos de Uso:</span>
            <span>{statusLabel(status.terms_of_use.status)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Política de Privacidade:</span>
            <span>{statusLabel(status.privacy_policy.status)}</span>
          </div>
          <div className="flex items-center justify-between">
            <span className="text-zinc-400">Declaração de idade (16+):</span>
            <span>{status.age_confirmed ? 'Registrada' : 'Ausente'}</span>
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 pt-1">
        <button
          type="button"
          onClick={() => setActiveDoc('terms_of_use')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200"
        >
          <FileText className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />
          Ver Termos de Uso
        </button>
        <button
          type="button"
          onClick={() => setActiveDoc('privacy_policy')}
          className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200"
        >
          <FileText className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />
          Ver Política de Privacidade
        </button>
      </div>
    </div>
  );
}
