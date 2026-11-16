import { useEffect, useState } from 'react';
import { Ban, Check, Inbox, X } from 'lucide-react';
import {
  socialPrivacyService,
  type DmMessageRequestDto,
} from '../../services/SocialPrivacyService';

interface DmRequestsPanelProps {
  backendUrl: string;
  sessionToken: string | null;
  onBlockUser?: (userId: string) => Promise<void> | void;
}

export function DmRequestsPanel({
  backendUrl,
  sessionToken,
  onBlockUser,
}: DmRequestsPanelProps) {
  const [requests, setRequests] = useState<DmMessageRequestDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!backendUrl || !sessionToken) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    socialPrivacyService
      .listDmRequests(backendUrl, sessionToken, controller.signal)
      .then((rows) => {
        if (!controller.signal.aborted) setRequests(rows);
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          setError(err instanceof Error ? err.message : 'Erro ao carregar solicitações.');
        }
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [backendUrl, sessionToken]);

  const handleAction = async (
    req: DmMessageRequestDto,
    action: 'accept' | 'decline' | 'block',
  ) => {
    if (!sessionToken) return;
    setBusyId(req.id);
    setError(null);
    try {
      if (action === 'accept') {
        await socialPrivacyService.acceptDmRequest(backendUrl, sessionToken, req.id);
      } else if (action === 'decline') {
        await socialPrivacyService.declineDmRequest(backendUrl, sessionToken, req.id);
      } else if (action === 'block') {
        await socialPrivacyService.declineDmRequest(backendUrl, sessionToken, req.id);
        await onBlockUser?.(req.sender_id);
      }
      setRequests((prev) => prev.filter((item) => item.id !== req.id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Falha ao processar solicitação.');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section
      aria-label="Solicitações de Mensagem"
      className="rounded-xl border border-zinc-800 bg-zinc-950 p-4 space-y-3 text-zinc-100"
    >
      <div className="flex items-center gap-2">
        <Inbox className="w-4 h-4 text-red-500" aria-hidden="true" />
        <h3 className="text-sm font-semibold text-white">Solicitações de Mensagem</h3>
      </div>

      {loading && <p className="text-xs text-zinc-400">Carregando solicitações...</p>}
      {error && (
        <p role="alert" className="text-xs text-red-300">
          {error}
        </p>
      )}
      {!loading && !error && requests.length === 0 && (
        <p className="text-xs text-zinc-400">Nenhuma solicitação pendente.</p>
      )}

      <ul className="space-y-2">
        {requests.map((req) => (
          <li
            key={req.id}
            className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900/70 px-3 py-2 text-xs"
          >
            <span className="text-zinc-200 truncate">
              Remetente: <code>{req.sender_id.slice(0, 8)}</code>
            </span>
            <div className="flex items-center gap-1.5">
              <button
                type="button"
                disabled={busyId === req.id}
                onClick={() => void handleAction(req, 'accept')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-red-600 hover:bg-red-500 text-white disabled:opacity-40"
              >
                <Check className="w-3.5 h-3.5" aria-hidden="true" />
                Aceitar
              </button>
              <button
                type="button"
                disabled={busyId === req.id}
                onClick={() => void handleAction(req, 'decline')}
                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-zinc-700 bg-zinc-800 hover:bg-zinc-700 text-zinc-200 disabled:opacity-40"
              >
                <X className="w-3.5 h-3.5" aria-hidden="true" />
                Recusar
              </button>
              {onBlockUser && (
                <button
                  type="button"
                  disabled={busyId === req.id}
                  onClick={() => void handleAction(req, 'block')}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-900/60 bg-red-950/40 hover:bg-red-900/50 text-red-300 disabled:opacity-40"
                >
                  <Ban className="w-3.5 h-3.5" aria-hidden="true" />
                  Bloquear
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
