import { useEffect, useRef, useState } from 'react';
import { Camera, Loader2, Trash2, User } from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { WindowControls } from '../../components/WindowControls';
import { avatarService } from '../../services/AvatarService';

interface ProfileOnboardingViewProps {
  username: string;
  backendUrl?: string;
  sessionToken?: string | null;
  onComplete: () => void;
}

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp']);

export function ProfileOnboardingView({
  username,
  backendUrl,
  sessionToken,
  onComplete,
}: ProfileOnboardingViewProps) {
  const [displayName, setDisplayName] = useState(username);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const saveProfile = useAppStore((state) => state.saveProfile);

  useEffect(() => {
    return () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  const handleFileChange = (file: File | undefined) => {
    if (!file) return;
    if (!ALLOWED_TYPES.has(file.type)) {
      setError('Formato inválido. Selecione uma imagem PNG, JPEG ou WebP.');
      return;
    }
    if (file.size > MAX_AVATAR_BYTES) {
      setError('A imagem deve ter no máximo 2 MB.');
      return;
    }
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setError(null);
    setSelectedFile(file);
    setPreviewUrl(URL.createObjectURL(file));
  };

  const handleClearFile = () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    setPreviewUrl(null);
    setSelectedFile(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const handleContinue = async () => {
    const trimmed = displayName.trim();
    setSaving(true);
    setError(null);
    try {
      let uploadedAvatarUrl: string | undefined;
      if (selectedFile) {
        uploadedAvatarUrl = await avatarService.uploadAvatar(selectedFile, {
          apiBaseUrl: backendUrl,
          token: sessionToken,
        });
      }
      if (uploadedAvatarUrl || (trimmed && trimmed !== username)) {
        await saveProfile({
          ...(trimmed && trimmed !== username ? { displayName: trimmed } : {}),
          ...(uploadedAvatarUrl ? { avatarUrl: uploadedAvatarUrl } : {}),
        });
      }
      onComplete();
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Não foi possível salvar seu perfil.',
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="relative flex flex-col items-center justify-center min-h-screen w-screen bg-black text-zinc-100 p-4 sm:p-6 overflow-y-auto select-none">
      <div
        data-tauri-drag-region
        className="absolute top-0 left-0 right-0 h-9 flex items-center justify-end px-3 z-50"
      >
        <WindowControls />
      </div>

      <div className="w-full max-w-md rounded-2xl border border-zinc-800/80 bg-zinc-950 p-6 sm:p-8 shadow-2xl max-h-[calc(100vh-3rem)] overflow-y-auto">
        <div className="space-y-5 text-zinc-100">
      <div className="text-center space-y-1.5">
        <h2 className="text-xl font-bold text-white">Seu perfil, sua identidade.</h2>
        <p className="text-xs text-zinc-400">
          Adicione uma foto e escolha como quer aparecer para seus amigos.
        </p>
      </div>

      <div className="flex flex-col items-center gap-3">
        <div className="w-20 h-20 rounded-full bg-zinc-900 border border-zinc-700 overflow-hidden flex items-center justify-center text-2xl font-bold text-red-400">
          {previewUrl ? (
            <img src={previewUrl} alt="Prévia do avatar" className="w-full h-full object-cover" />
          ) : (
            username.slice(0, 2).toUpperCase() || <User className="w-8 h-8" aria-hidden="true" />
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/png,image/jpeg,image/webp"
          className="hidden"
          onChange={(e) => handleFileChange(e.target.files?.[0])}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={saving}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-zinc-700 bg-zinc-900 hover:bg-zinc-800 text-xs text-zinc-200"
          >
            <Camera className="w-3.5 h-3.5 text-red-400" aria-hidden="true" />
            Escolher foto
          </button>
          {selectedFile && (
            <button
              type="button"
              disabled={saving}
              onClick={handleClearFile}
              className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-zinc-800 bg-zinc-950 hover:bg-zinc-900 text-xs text-zinc-400"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
              Remover
            </button>
          )}
        </div>
      </div>

      {error && (
        <p role="alert" className="text-xs text-red-300 text-center">
          {error}
        </p>
      )}

      <label className="block space-y-1.5 text-xs">
        <span className="block text-zinc-300 font-medium">Nome de exibição</span>
        <input
          type="text"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={64}
          disabled={saving}
          className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500"
        />
      </label>

      <div className="space-y-2 pt-1">
        <button
          type="button"
          disabled={saving}
          onClick={() => void handleContinue()}
          className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-red-600 hover:bg-red-500 disabled:opacity-40 text-sm font-medium text-white"
        >
          {saving && <Loader2 className="w-4 h-4 animate-spin" aria-hidden="true" />}
          Continuar para o NEXUS
        </button>
        <button
          type="button"
          disabled={saving}
          onClick={onComplete}
          className="w-full px-4 py-2 rounded-lg border border-zinc-800 bg-transparent hover:bg-zinc-900 text-xs text-zinc-400 hover:text-zinc-200 cursor-pointer"
        >
          Pular por enquanto
        </button>
      </div>
        </div>
      </div>
    </div>
  );
}
