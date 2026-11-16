import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, LogOut, RefreshCw, ShieldCheck } from 'lucide-react';
import {
  LegalApiError,
  legalDocumentsService,
  type LegalDocumentDto,
  type LegalDocumentType,
} from '../../services/LegalDocumentsService';
import { LegalDocumentViewer } from './LegalDocumentViewer';

interface LegalRegularizationViewProps {
  backendUrl: string;
  sessionToken: string;
  appVersion?: string;
  requireAgeConfirmation?: boolean;
  onCompleted: () => void;
  onLogout: () => void;
}

export function LegalRegularizationView({
  backendUrl,
  sessionToken,
  appVersion,
  requireAgeConfirmation = false,
  onCompleted,
  onLogout,
}: LegalRegularizationViewProps) {
  const [documents, setDocuments] = useState<LegalDocumentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [activeDoc, setActiveDoc] = useState<LegalDocumentType | null>(null);

  const [ageConfirmed, setAgeConfirmed] = useState(false);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [privacyAcknowledged, setPrivacyAcknowledged] = useState(false);
  const [confirmedKeys, setConfirmedKeys] = useState<Set<string>>(() => new Set());
  const lastTriggerRef = useRef<HTMLButtonElement | null>(null);
  const wasViewerOpenRef = useRef(false);

  const docKey = (doc: LegalDocumentDto) => `${doc.doc_type}:${doc.version}:${doc.content_hash}`;

  const loadDocuments = useCallback(async (signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const res = await legalDocumentsService.fetchCurrentDocuments(backendUrl, signal);
      setDocuments(res.documents);
    } catch (err) {
      if (signal?.aborted) return;
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível carregar os documentos legais.',
      );
    } finally {
      if (!signal?.aborted) {
        setLoading(false);
      }
    }
  }, [backendUrl]);

  useEffect(() => {
    const controller = new AbortController();
    void loadDocuments(controller.signal);
    return () => controller.abort();
  }, [loadDocuments]);

  useEffect(() => {
    if (activeDoc) {
      wasViewerOpenRef.current = true;
    } else if (wasViewerOpenRef.current) {
      wasViewerOpenRef.current = false;
      lastTriggerRef.current?.focus();
    }
  }, [activeDoc]);

  const termsDoc = documents.find((d) => d.doc_type === 'terms_of_use') ?? null;
  const privacyDoc = documents.find((d) => d.doc_type === 'privacy_policy') ?? null;

  const canSubmit =
    !loading &&
    !submitting &&
    Boolean(termsDoc) &&
    Boolean(privacyDoc) &&
    termsAccepted &&
    privacyAcknowledged &&
    (!requireAgeConfirmation || ageConfirmed);

  const handleAcceptAll = async () => {
    if (!termsDoc || !privacyDoc || !canSubmit) return;
    setSubmitting(true);
    setError(null);

    try {
      const termsKey = docKey(termsDoc);
      if (!confirmedKeys.has(termsKey)) {
        await legalDocumentsService.acceptDocument(backendUrl, sessionToken, {
          doc_type: 'terms_of_use',
          version: termsDoc.version,
          content_hash: termsDoc.content_hash,
          record_type: 'acceptance',
          flow_origin: 'regularization',
          app_version: appVersion,
        });
        setConfirmedKeys((prev) => new Set(prev).add(termsKey));
      }

      const privacyKey = docKey(privacyDoc);
      if (!confirmedKeys.has(privacyKey)) {
        await legalDocumentsService.acceptDocument(backendUrl, sessionToken, {
          doc_type: 'privacy_policy',
          version: privacyDoc.version,
          content_hash: privacyDoc.content_hash,
          record_type: 'acknowledgement',
          flow_origin: 'regularization',
          app_version: appVersion,
        });
        setConfirmedKeys((prev) => new Set(prev).add(privacyKey));
      }

      onCompleted();
    } catch (err) {
      if (err instanceof LegalApiError && err.code === 'LEGAL_VERSION_MISMATCH') {
        setTermsAccepted(false);
        setPrivacyAcknowledged(false);
        setError('Os documentos foram atualizados. Confira a nova versão antes de aceitar.');
        await loadDocuments();
      } else {
        setError(
          err instanceof Error
            ? err.message
            : 'Falha ao registrar aceite. Tente novamente.',
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  if (activeDoc) {
    const doc = activeDoc === 'terms_of_use' ? termsDoc : privacyDoc;
    const title = activeDoc === 'terms_of_use' ? 'Termos de Uso' : 'Política de Privacidade';
    return (
      <div className="w-full max-w-xl mx-auto p-4">
        <LegalDocumentViewer
          title={title}
          document={doc}
          loading={loading}
          error={error}
          onRetry={() => void loadDocuments()}
          onBack={() => setActiveDoc(null)}
        />
      </div>
    );
  }

  return (
    <div className="w-full max-w-lg mx-auto rounded-2xl bg-zinc-950 border border-zinc-800 p-6 text-zinc-100 space-y-5 shadow-2xl">
      <div className="flex items-start gap-3">
        <ShieldCheck className="w-6 h-6 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <h2 className="text-lg font-semibold text-white">Atualização de Documentos Legais</h2>
          <p className="text-sm text-zinc-400 mt-1">
            Para continuar usando o NEXUS, leia e confirme os documentos vigentes.
          </p>
        </div>
      </div>

      {error && (
        <div
          role="alert"
          className="flex items-start gap-2.5 p-3 rounded-lg border border-red-900/60 bg-red-950/30 text-sm text-red-200"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0 mt-0.5" aria-hidden="true" />
          <div className="flex-1 space-y-1.5">
            <p>{error}</p>
            <button
              type="button"
              onClick={() => void loadDocuments()}
              className="inline-flex items-center gap-1 text-xs font-medium text-red-300 hover:text-white underline"
            >
              <RefreshCw className="w-3 h-3" aria-hidden="true" />
              Recarregar documentos
            </button>
          </div>
        </div>
      )}

      <div className="space-y-3 rounded-xl bg-zinc-900/70 border border-zinc-800 p-4">
        {requireAgeConfirmation && (
          <label className="flex items-start gap-2.5 text-sm text-zinc-200 cursor-pointer">
            <input
              type="checkbox"
              checked={ageConfirmed}
              onChange={(e) => setAgeConfirmed(e.target.checked)}
              className="mt-1 accent-red-600"
            />
            <span>Confirmo que tenho 16 anos ou mais.</span>
          </label>
        )}

        <div className="flex items-start gap-2.5 text-sm text-zinc-200">
          <input
            id="reg-terms"
            type="checkbox"
            checked={termsAccepted}
            onChange={(e) => setTermsAccepted(e.target.checked)}
            className="mt-1 accent-red-600"
          />
          <label htmlFor="reg-terms" className="flex-1">
            Li e aceito os{' '}
            <button
              type="button"
              onClick={(e) => {
                lastTriggerRef.current = e.currentTarget;
                setActiveDoc('terms_of_use');
              }}
              className="text-red-400 hover:text-red-300 underline font-medium"
            >
              Termos de Uso
            </button>
            {termsDoc ? ` (v${termsDoc.version})` : ''}.
          </label>
        </div>

        <div className="flex items-start gap-2.5 text-sm text-zinc-200">
          <input
            id="reg-privacy"
            type="checkbox"
            checked={privacyAcknowledged}
            onChange={(e) => setPrivacyAcknowledged(e.target.checked)}
            className="mt-1 accent-red-600"
          />
          <label htmlFor="reg-privacy" className="flex-1">
            Li e estou ciente da{' '}
            <button
              type="button"
              onClick={(e) => {
                lastTriggerRef.current = e.currentTarget;
                setActiveDoc('privacy_policy');
              }}
              className="text-red-400 hover:text-red-300 underline font-medium"
            >
              Política de Privacidade
            </button>
            {privacyDoc ? ` (v${privacyDoc.version})` : ''}.
          </label>
        </div>
      </div>

      <div className="flex items-center justify-between gap-3 pt-1">
        <button
          type="button"
          onClick={onLogout}
          disabled={submitting}
          className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-sm text-zinc-200"
        >
          <LogOut className="w-4 h-4" aria-hidden="true" />
          Encerrar sessão
        </button>

        <button
          type="button"
          onClick={() => void handleAcceptAll()}
          disabled={!canSubmit}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-sm font-medium text-white"
        >
          {submitting ? (
            <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />
          ) : (
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" />
          )}
          Confirmar e continuar
        </button>
      </div>
    </div>
  );
}
