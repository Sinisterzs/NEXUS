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

/**
 * Returns true when a Google sign-in failure should offer "Esqueceu sua senha?"
 * as a direct action (existing account conflict / unlinked Google identity).
 */
export function isAccountRecoveryCandidateError(rawError: unknown): boolean {
  const rawMsg =
    typeof rawError === 'string' ? rawError : (rawError as any)?.message || '';
  return (
    rawMsg.includes('ACCOUNT_CONFLICT_EMAIL_EXISTS') ||
    rawMsg.includes('GOOGLE_IDENTITY_NOT_LINKED')
  );
}

/**
 * Maps password recovery (forgot / reset) errors into user-facing Portuguese.
 * Never echoes the reset token back to the user or to logs.
 */
export function mapPasswordResetError(rawError: unknown): string {
  const rawMsg =
    typeof rawError === 'string'
      ? rawError
      : (rawError as any)?.message || 'Não foi possível concluir a recuperação de senha.';

  if (rawMsg.includes('RESET_TOKEN_INVALID_OR_EXPIRED')) {
    return 'O código ou link de recuperação é inválido, já foi usado ou expirou. Solicite um novo código.';
  }
  if (rawMsg.includes('RESET_TOKEN_INVALID')) {
    return 'Código inválido ou já utilizado.';
  }
  if (rawMsg.includes('RESET_TOKEN_EXPIRED')) {
    return 'Este código expirou (validade de 15 minutos). Solicite um novo.';
  }
  if (rawMsg.includes('RESET_PASSWORD_WEAK')) {
    return 'A nova senha é muito fraca. Use no mínimo 8 caracteres.';
  }
  if (rawMsg.includes('RATE_LIMITED') || rawMsg.includes('TOO_MANY_REQUESTS')) {
    return 'Muitas tentativas de recuperação. Aguarde alguns minutos e tente novamente.';
  }
  if (rawMsg.includes('NETWORK_ERROR') || rawMsg.includes('Falha de conexão')) {
    return 'Não foi possível conectar ao servidor NEXUS. Verifique sua conexão e tente novamente.';
  }

  const codeMatch = rawMsg.match(/^[A-Z0-9_]+:\s*(.+)$/);
  if (codeMatch && codeMatch[1]) {
    return codeMatch[1].trim();
  }
  return rawMsg;
}

/** True when the error means the reset token is unusable and a new one must be requested. */
export function isResetTokenInvalidError(rawError: unknown): boolean {
  const rawMsg =
    typeof rawError === 'string' ? rawError : (rawError as any)?.message || '';
  return (
    rawMsg.includes('RESET_TOKEN_INVALID_OR_EXPIRED') ||
    rawMsg.includes('RESET_TOKEN_INVALID') ||
    rawMsg.includes('RESET_TOKEN_EXPIRED')
  );
}
