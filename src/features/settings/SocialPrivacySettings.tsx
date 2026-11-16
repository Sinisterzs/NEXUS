import { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, Shield } from 'lucide-react';
import {
  socialPrivacyService,
  type DmPolicy,
  type FriendRequestPolicy,
  type PrivateCallPolicy,
} from '../../services/SocialPrivacyService';

interface SocialPrivacySettingsProps {
  backendUrl: string;
  sessionToken: string | null;
}

export function SocialPrivacySettings({
  backendUrl,
  sessionToken,
}: SocialPrivacySettingsProps) {
  const [dmPolicy, setDmPolicy] = useState<DmPolicy>('friends_and_community');
  const [friendPolicy, setFriendPolicy] = useState<FriendRequestPolicy>('everyone');
  const [callPolicy, setCallPolicy] = useState<PrivateCallPolicy>('friends_only');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!backendUrl || !sessionToken) return;
    const controller = new AbortController();
    setLoading(true);
    setError(null);

    socialPrivacyService
      .getPreferences(backendUrl, sessionToken, controller.signal)
      .then((prefs) => {
        if (controller.signal.aborted) return;
        setDmPolicy(prefs.dm_policy);
        setFriendPolicy(prefs.friend_request_policy);
        setCallPolicy(prefs.private_call_policy);
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Erro ao carregar preferências.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });

    return () => controller.abort();
  }, [backendUrl, sessionToken]);

  const handleSave = async () => {
    if (!backendUrl || !sessionToken) return;
    setSaving(true);
    setError(null);
    setSavedNotice(null);
    try {
      await socialPrivacyService.updatePreferences(backendUrl, sessionToken, {
        dm_policy: dmPolicy,
        friend_request_policy: friendPolicy,
        private_call_policy: callPolicy,
      });
      setSavedNotice('Preferências salvas no servidor.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erro ao salvar preferências.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      aria-label="Privacidade e Segurança Social"
      className="rounded-xl border border-zinc-800 bg-zinc-950 p-5 space-y-4 text-zinc-100"
    >
      <div className="flex items-start gap-2.5">
        <Shield className="w-5 h-5 text-red-500 shrink-0 mt-0.5" aria-hidden="true" />
        <div>
          <h3 className="text-base font-semibold text-white">Privacidade e Segurança Social</h3>
          <p className="text-xs text-zinc-400 mt-0.5">
            Configurações em preparação: as preferências são salvas no servidor e serão aplicadas
            gradualmente após a ativação definitiva.
          </p>
        </div>
      </div>

      {loading && (
        <p className="text-xs text-zinc-400 flex items-center gap-1.5">
          <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />
          Carregando preferências...
        </p>
      )}

      {error && (
        <div
          role="alert"
          className="flex items-center gap-2 p-2.5 rounded-lg border border-red-900/60 bg-red-950/30 text-xs text-red-200"
        >
          <AlertCircle className="w-4 h-4 text-red-400 shrink-0" aria-hidden="true" />
          <span>{error}</span>
        </div>
      )}

      {savedNotice && (
        <div
          role="status"
          className="flex items-center gap-2 p-2.5 rounded-lg border border-emerald-900/60 bg-emerald-950/30 text-xs text-emerald-200"
        >
          <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" aria-hidden="true" />
          <span>{savedNotice}</span>
        </div>
      )}

      <div className="grid gap-3 sm:grid-cols-3">
        <label className="space-y-1 text-xs">
          <span className="block text-zinc-300 font-medium">Mensagens privadas</span>
          <select
            value={dmPolicy}
            onChange={(e) => setDmPolicy(e.target.value as DmPolicy)}
            disabled={loading || saving}
            className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-2.5 py-2 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="friends_only">Somente amigos</option>
            <option value="friends_and_community">Amigos e comunidades</option>
            <option value="nobody">Ninguém</option>
          </select>
        </label>

        <label className="space-y-1 text-xs">
          <span className="block text-zinc-300 font-medium">Solicitações de amizade</span>
          <select
            value={friendPolicy}
            onChange={(e) => setFriendPolicy(e.target.value as FriendRequestPolicy)}
            disabled={loading || saving}
            className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-2.5 py-2 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="everyone">Qualquer pessoa</option>
            <option value="community_only">Mesmas comunidades</option>
            <option value="nobody">Ninguém</option>
          </select>
        </label>

        <label className="space-y-1 text-xs">
          <span className="block text-zinc-300 font-medium">Chamadas privadas</span>
          <select
            value={callPolicy}
            onChange={(e) => setCallPolicy(e.target.value as PrivateCallPolicy)}
            disabled={loading || saving}
            className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-2.5 py-2 text-zinc-100 focus:outline-none focus:ring-2 focus:ring-red-500"
          >
            <option value="friends_only">Somente amigos</option>
            <option value="nobody">Ninguém</option>
          </select>
        </label>
      </div>

      <div className="flex justify-end">
        <button
          type="button"
          onClick={() => void handleSave()}
          disabled={loading || saving || !sessionToken}
          className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-xs font-medium text-white"
        >
          {saving && <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" />}
          Salvar preferências
        </button>
      </div>
    </section>
  );
}
