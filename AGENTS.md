Durante o desenvolvimento, priorize Vite HMR e verificações rápidas. Não execute builds Release ou gere instaladores após alterações pequenas, a menos que seja necessário validar funcionalidades nativas ou que o usuário solicite. Agrupe alterações relacionadas e faça um build Release ao final de cada etapa.

Nunca lance updates ou publique releases no GitHub sem autorização explícita do usuário.

Nunca execute instaladores NSIS (`setup.exe`) com argumentos silenciosos (`/S /D=...`) diretamente no host do Windows para testes locais sem isolar ou restaurar a chave de desinstalação `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\nexus`. Testes de integridade do updater devem utilizar extração de artefatos ou validação de manifestos sem alterar o registro do sistema operacional.
