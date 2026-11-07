import React, { useState } from 'react';
import {
  X,
  UserPlus,
  Clock,
  Send,
  Check,
  Ban,
  Search,
  Loader2,
  AlertCircle,
  UserCheck,
} from 'lucide-react';
import { useAppStore } from '../../stores/useAppStore';
import { Avatar } from '../../components/Avatar';

export const AddFriendModal: React.FC = () => {
  const isAddFriendModalOpen = useAppStore((state) => state.isAddFriendModalOpen);
  const closeAddFriendModal = useAppStore((state) => state.closeAddFriendModal);
  const friendRequests = useAppStore((state) => state.friendRequests);
  const sendFriendRequest = useAppStore((state) => state.sendFriendRequest);
  const acceptFriendRequest = useAppStore((state) => state.acceptFriendRequest);
  const rejectFriendRequest = useAppStore((state) => state.rejectFriendRequest);
  const cancelFriendRequest = useAppStore((state) => state.cancelFriendRequest);
  const searchUsers = useAppStore((state) => state.searchUsers);
  const userSearchResults = useAppStore((state) => state.userSearchResults);
  const isSearchingUsers = useAppStore((state) => state.isSearchingUsers);
  const clearUserSearch = useAppStore((state) => state.clearUserSearch);

  const [activeTab, setActiveTab] = useState<'add' | 'pending' | 'outgoing'>('add');
  const [usernameInput, setUsernameInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [statusMessage, setStatusMessage] = useState<{ text: string; isError: boolean } | null>(null);

  if (!isAddFriendModalOpen) return null;

  const handleSend = async (targetUsername?: string) => {
    const target = (targetUsername || usernameInput).trim();
    if (!target) return;

    setIsSending(true);
    setStatusMessage(null);

    try {
      await sendFriendRequest(target);
      setStatusMessage({
        text: `Solicitação de amizade enviada com sucesso para ${target}!`,
        isError: false,
      });
      setUsernameInput('');
      clearUserSearch();
    } catch (err: any) {
      setStatusMessage({
        text: err?.message || 'Falha ao enviar solicitação.',
        isError: true,
      });
    } finally {
      setIsSending(false);
    }
  };

  const handleSearchChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value;
    setUsernameInput(val);
    setStatusMessage(null);
    if (val.trim().length >= 2) {
      searchUsers(val);
    } else {
      clearUserSearch();
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/75 backdrop-blur-xs animate-in fade-in duration-150">
      <div
        className="w-full max-w-lg bg-nexus-surface border border-nexus-border rounded-xl shadow-2xl overflow-hidden flex flex-col max-h-[85vh]"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-nexus-border bg-nexus-panel/50">
          <div className="flex items-center gap-2.5">
            <UserPlus className="w-5 h-5 text-nexus-accent" />
            <h3 className="text-sm font-bold text-nexus-text">Gerenciar Amigos & Solicitações</h3>
          </div>
          <button
            onClick={closeAddFriendModal}
            className="p-1 rounded-md text-nexus-muted hover:text-nexus-text hover:bg-nexus-surface transition-nexus"
            title="Fechar"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Navigation Tabs */}
        <div className="flex items-center gap-1 px-5 pt-3 border-b border-nexus-border/60 bg-nexus-bg/50 text-xs">
          <button
            onClick={() => setActiveTab('add')}
            className={`pb-2.5 px-3 font-medium border-b-2 transition-nexus flex items-center gap-2 ${
              activeTab === 'add'
                ? 'border-nexus-accent text-nexus-text font-bold'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            }`}
          >
            <UserPlus className="w-3.5 h-3.5" />
            <span>Adicionar Amigo</span>
          </button>

          <button
            onClick={() => setActiveTab('pending')}
            className={`pb-2.5 px-3 font-medium border-b-2 transition-nexus flex items-center gap-2 ${
              activeTab === 'pending'
                ? 'border-nexus-accent text-nexus-text font-bold'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            }`}
          >
            <Clock className="w-3.5 h-3.5" />
            <span>Pendentes</span>
            {friendRequests.incoming.length > 0 && (
              <span className="px-1.5 py-0.2 rounded-full text-[10px] font-bold bg-nexus-accent text-white">
                {friendRequests.incoming.length}
              </span>
            )}
          </button>

          <button
            onClick={() => setActiveTab('outgoing')}
            className={`pb-2.5 px-3 font-medium border-b-2 transition-nexus flex items-center gap-2 ${
              activeTab === 'outgoing'
                ? 'border-nexus-accent text-nexus-text font-bold'
                : 'border-transparent text-nexus-muted hover:text-nexus-text'
            }`}
          >
            <Send className="w-3.5 h-3.5" />
            <span>Enviadas ({friendRequests.outgoing.length})</span>
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 overflow-y-auto space-y-4 flex-1">
          {/* Tab 1: Adicionar Amigo */}
          {activeTab === 'add' && (
            <div className="space-y-4">
              <div>
                <label className="block text-xs font-semibold text-nexus-text mb-1">
                  Buscar por nome de usuário
                </label>
                <p className="text-[11px] text-nexus-muted mb-2">
                  Digite o nome de usuário exato para enviar uma solicitação de amizade no NEXUS.
                </p>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-nexus-muted pointer-events-none" />
                    <input
                      type="text"
                      value={usernameInput}
                      onChange={handleSearchChange}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleSend();
                      }}
                      placeholder="Ex: alex, beatriz..."
                      className="w-full bg-nexus-bg text-nexus-text text-xs pl-9 pr-3 py-2 rounded-lg border border-nexus-border focus:border-nexus-accent focus:outline-hidden transition-nexus"
                    />
                  </div>
                  <button
                    onClick={() => handleSend()}
                    disabled={isSending || !usernameInput.trim()}
                    className="px-4 py-2 rounded-lg bg-nexus-accent hover:bg-nexus-accent-hover disabled:opacity-50 text-white text-xs font-medium transition-nexus flex items-center gap-1.5 shrink-0 shadow-xs"
                  >
                    {isSending ? (
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    ) : (
                      <Send className="w-3.5 h-3.5" />
                    )}
                    <span>Enviar</span>
                  </button>
                </div>
              </div>

              {/* Status Alert */}
              {statusMessage && (
                <div
                  className={`p-3 rounded-lg text-xs flex items-center gap-2 border ${
                    statusMessage.isError
                      ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
                      : 'bg-emerald-500/10 border-emerald-500/30 text-emerald-300'
                  }`}
                >
                  {statusMessage.isError ? (
                    <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
                  ) : (
                    <Check className="w-4 h-4 shrink-0 text-emerald-400" />
                  )}
                  <span>{statusMessage.text}</span>
                </div>
              )}

              {/* Search Live Results */}
              {isSearchingUsers && (
                <div className="flex items-center justify-center py-6 text-nexus-muted gap-2 text-xs">
                  <Loader2 className="w-4 h-4 animate-spin text-nexus-accent" />
                  <span>Pesquisando no NEXUS...</span>
                </div>
              )}

              {!isSearchingUsers && userSearchResults.length > 0 && (
                <div className="space-y-2 pt-2">
                  <h4 className="text-[11px] font-bold text-nexus-muted uppercase tracking-wider">
                    Usuários Encontrados
                  </h4>
                  <div className="space-y-1.5 max-h-48 overflow-y-auto pr-1">
                    {userSearchResults.map((user) => (
                      <div
                        key={user.id}
                        className="flex items-center justify-between p-2.5 rounded-lg bg-nexus-panel/60 border border-nexus-border/60 hover:border-nexus-border transition-nexus"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <Avatar name={user.displayName} size="sm" />
                          <div className="min-w-0">
                            <span className="text-xs font-semibold text-nexus-text block truncate">
                              {user.displayName}
                            </span>
                            <span className="text-[10px] text-nexus-muted font-mono">
                              @{user.username} {user.tag}
                            </span>
                          </div>
                        </div>

                        <div>
                          {user.isFriend ? (
                            <span className="inline-flex items-center gap-1 text-[11px] text-emerald-400 font-medium px-2 py-1 rounded bg-emerald-500/10">
                              <UserCheck className="w-3 h-3" />
                              <span>Amigo</span>
                            </span>
                          ) : user.hasPendingRequest ? (
                            <span className="text-[11px] text-amber-400 font-medium px-2 py-1 rounded bg-amber-500/10">
                              Pendente
                            </span>
                          ) : user.isBlocked ? (
                            <span className="text-[11px] text-rose-400 font-medium px-2 py-1 rounded bg-rose-500/10">
                              Bloqueado
                            </span>
                          ) : (
                            <button
                              onClick={() => handleSend(user.username)}
                              disabled={isSending}
                              className="px-2.5 py-1 rounded bg-nexus-accent hover:bg-nexus-accent-hover text-white text-xs font-medium transition-nexus flex items-center gap-1"
                            >
                              <UserPlus className="w-3 h-3" />
                              <span>Adicionar</span>
                            </button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Tab 2: Solicitações Recebidas (Pendentes) */}
          {activeTab === 'pending' && (
            <div className="space-y-2">
              {friendRequests.incoming.length === 0 ? (
                <div className="text-center py-10 space-y-2">
                  <div className="w-12 h-12 rounded-full bg-nexus-panel flex items-center justify-center mx-auto text-nexus-muted">
                    <Check className="w-6 h-6" />
                  </div>
                  <p className="text-xs text-nexus-muted">
                    Nenhuma solicitação de amizade pendente no momento.
                  </p>
                </div>
              ) : (
                friendRequests.incoming.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-nexus-panel/70 border border-nexus-border transition-nexus"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={req.displayName} status={req.status as any} size="md" />
                      <div className="min-w-0">
                        <span className="text-xs font-bold text-nexus-text block truncate">
                          {req.displayName}
                        </span>
                        <span className="text-[10px] text-nexus-muted font-mono">
                          @{req.username} {req.tag}
                        </span>
                      </div>
                    </div>

                    <div className="flex items-center gap-2 shrink-0">
                      <button
                        onClick={() => acceptFriendRequest(req.id)}
                        className="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-nexus flex items-center gap-1 shadow-xs"
                      >
                        <Check className="w-3.5 h-3.5" />
                        <span>Aceitar</span>
                      </button>
                      <button
                        onClick={() => rejectFriendRequest(req.id)}
                        className="px-3 py-1.5 rounded-lg bg-nexus-surface hover:bg-rose-500/20 text-rose-400 border border-nexus-border text-xs font-medium transition-nexus flex items-center gap-1"
                      >
                        <Ban className="w-3.5 h-3.5" />
                        <span>Recusar</span>
                      </button>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}

          {/* Tab 3: Solicitações Enviadas */}
          {activeTab === 'outgoing' && (
            <div className="space-y-2">
              {friendRequests.outgoing.length === 0 ? (
                <div className="text-center py-10 space-y-2">
                  <div className="w-12 h-12 rounded-full bg-nexus-panel flex items-center justify-center mx-auto text-nexus-muted">
                    <Send className="w-6 h-6" />
                  </div>
                  <p className="text-xs text-nexus-muted">
                    Você não possui solicitações de amizade enviadas pendentes.
                  </p>
                </div>
              ) : (
                friendRequests.outgoing.map((req) => (
                  <div
                    key={req.id}
                    className="flex items-center justify-between p-3 rounded-lg bg-nexus-panel/70 border border-nexus-border transition-nexus"
                  >
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={req.displayName} status={req.status as any} size="md" />
                      <div className="min-w-0">
                        <span className="text-xs font-bold text-nexus-text block truncate">
                          {req.displayName}
                        </span>
                        <span className="text-[10px] text-nexus-muted font-mono">
                          @{req.username} {req.tag}
                        </span>
                      </div>
                    </div>

                    <button
                      onClick={() => cancelFriendRequest(req.id)}
                      className="px-3 py-1.5 rounded-lg bg-nexus-surface hover:bg-nexus-border text-nexus-muted hover:text-nexus-text text-xs font-medium border border-nexus-border transition-nexus flex items-center gap-1"
                    >
                      <X className="w-3.5 h-3.5" />
                      <span>Cancelar</span>
                    </button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
