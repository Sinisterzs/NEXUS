/**
 * Pure helpers for the password recovery flow (no React / Tauri imports so they
 * can be unit-tested directly under Node).
 *
 * Security rules:
 * - Reset tokens are single-use secrets: never log them, never put them in the
 *   window URL/history, never echo them in error messages.
 * - The "forgot" confirmation is always neutral (no account enumeration).
 */

export type RecoveryStep = 'forgot_request' | 'reset_password' | 'reset_success';

export const RESET_MIN_PASSWORD_LENGTH = 8;
export const RESET_TOKEN_VALIDITY_MINUTES = 15;

export const NEUTRAL_RESET_NOTICE =
  `Se o e-mail informado estiver cadastrado, enviamos um código ou link de recuperação de uso único, válido por ${RESET_TOKEN_VALIDITY_MINUTES} minutos.`;

export const RESET_SUCCESS_NOTICE =
  'Sua senha foi redefinida. Por segurança, todas as sessões anteriores foram encerradas.';

const TOKEN_PARAM_RE = /[?&#]token=([^&#\s]+)/i;
const MAX_TOKEN_LENGTH = 512;

/**
 * Extracts a clean reset token from whatever the user pasted: a bare token,
 * a `nexus://reset-password?token=...` deep link or an http(s) URL.
 * Returns '' when nothing usable is found. The original pasted text is never
 * retained by callers — only the returned token.
 */
export function extractResetToken(input: string): string {
  if (typeof input !== 'string') return '';
  const raw = input.trim();
  if (!raw) return '';

  let candidate = raw;
  const looksLikeLink = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) || /[?&#]token=/i.test(raw);
  if (looksLikeLink) {
    let found: string | null = null;
    try {
      const url = new URL(raw);
      found =
        url.searchParams.get('token') ||
        new URLSearchParams(url.hash.replace(/^#/, '')).get('token');
    } catch {
      // not a parseable URL; fall back to regex below
    }
    if (!found) {
      const m = raw.match(TOKEN_PARAM_RE);
      if (m) {
        try {
          found = decodeURIComponent(m[1]);
        } catch {
          found = m[1];
        }
      }
    }
    if (!found) return '';
    candidate = found;
  }

  const cleaned = candidate.replace(/\s+/g, '');
  if (!cleaned || cleaned.length > MAX_TOKEN_LENGTH) return '';
  return cleaned;
}

export function isValidRecoveryEmail(email: string): boolean {
  const e = (email || '').trim();
  return e.length >= 3 && /^[^\s@]+@[^\s@]+$/.test(e);
}

export interface PasswordChecks {
  minLength: boolean;
  matches: boolean;
  valid: boolean;
}

export function checkNewPassword(password: string, confirm: string): PasswordChecks {
  const minLength = password.length >= RESET_MIN_PASSWORD_LENGTH;
  const matches = password.length > 0 && password === confirm;
  return { minLength, matches, valid: minLength && matches };
}

/** First blocking validation message for the reset form, or null when ready to submit. */
export function validateResetForm(token: string, password: string, confirm: string): string | null {
  if (!token.trim()) return 'Cole o código ou link de recuperação recebido por e-mail.';
  if (password.length < RESET_MIN_PASSWORD_LENGTH) {
    return `A nova senha deve ter no mínimo ${RESET_MIN_PASSWORD_LENGTH} caracteres.`;
  }
  if (password !== confirm) return 'As senhas digitadas não coincidem.';
  return null;
}

/**
 * Pure step transitions of the recovery flow.
 *  - requested:   forgot request accepted (always neutral) -> reset_password
 *  - haveCode:    user already owns a code                  -> reset_password (no banner)
 *  - needNewCode: token invalid/expired                     -> forgot_request
 *  - succeeded:   password reset done                       -> reset_success
 */
export type RecoveryEvent = 'requested' | 'haveCode' | 'needNewCode' | 'succeeded';

export function nextRecoveryStep(step: RecoveryStep, event: RecoveryEvent): RecoveryStep {
  switch (event) {
    case 'requested':
      return step === 'forgot_request' ? 'reset_password' : step;
    case 'haveCode':
      return step === 'forgot_request' ? 'reset_password' : step;
    case 'needNewCode':
      return step === 'reset_password' ? 'forgot_request' : step;
    case 'succeeded':
      return step === 'reset_password' ? 'reset_success' : step;
    default:
      return step;
  }
}
