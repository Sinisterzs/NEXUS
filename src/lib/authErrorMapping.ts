/**
 * Maps backend and Tauri authentication error responses into user-facing Portuguese explanations.
 *
 * Security Rules:
 * - Never advises password login to users whose accounts do not have a password (Google-only accounts).
 * - Distinguishes between password-protected accounts with the same email (which can be linked via password login)
 *   and passwordless accounts with unlinked Google identities (which require safe account recovery).
 * - Never performs or encourages unsafe automatic account linking.
 */

export function mapGoogleAuthError(
  rawError: unknown,
  context: 'view' | 'modal' = 'view'
): string {
  const rawMsg =
    typeof rawError === 'string'
      ? rawError
      : (rawError as any)?.message || 'Falha ao autenticar com o Google.';

  // 1. Passwordless account with unlinked Google identity (or legacy unlinked Google signup)
  if (
    rawMsg.includes('GOOGLE_IDENTITY_NOT_LINKED') ||
    rawMsg.includes('sem senha cuja identidade Google não está vinculada')
  ) {
    return 'Este e-mail pertence a uma conta NEXUS sem senha não vinculada a este login Google. Por segurança, o vínculo automático não é permitido. Entre em contato com o suporte para assistência.';
  }

  // 2. Account exists with a password -> user can prove ownership by logging in with password to link
  if (
    rawMsg.includes('ACCOUNT_CONFLICT_EMAIL_EXISTS') ||
    rawMsg.includes('Para vincular, faça login com sua senha') ||
    rawMsg.includes('Já existe uma conta cadastrada com este e-mail')
  ) {
    if (context === 'modal') {
      return 'Já existe uma conta cadastrada com este e-mail no NEXUS. Por segurança, faça login com sua senha abaixo e vincule sua conta Google nas Configurações.';
    }
    return 'Já existe uma conta cadastrada com este e-mail no NEXUS. Faça login com sua senha abaixo para vincular.';
  }

  // 3. Google account already linked to another user profile
  if (
    rawMsg.includes('OAUTH_ACCOUNT_ALREADY_LINKED') ||
    rawMsg.includes('já está vinculada a outro usuário')
  ) {
    return 'Esta conta Google já está vinculada a outro usuário do NEXUS.';
  }

  // 4. Token validation or expiration errors
  if (
    rawMsg.includes('INVALID_OAUTH_TOKEN') ||
    rawMsg.includes('Token OAuth inválido')
  ) {
    return 'Sessão ou token do Google inválido ou expirado. Tente fazer login novamente.';
  }

  // 5. Provider email not verified
  if (
    rawMsg.includes('OAUTH_EMAIL_NOT_VERIFIED') ||
    rawMsg.includes('não foi verificado pelo provedor')
  ) {
    return 'O e-mail da conta Google não foi verificado. Verifique seu e-mail no Google antes de continuar.';
  }

  // 6. Generic formatted error code stripping: e.g. "SOME_CODE: Mensagem em português"
  const codeMatch = rawMsg.match(/^[A-Z0-9_]+:\s*(.+)$/);
  if (codeMatch && codeMatch[1]) {
    return codeMatch[1].trim();
  }

  return rawMsg;
}
