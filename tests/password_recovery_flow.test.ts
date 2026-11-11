import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractResetToken,
  isValidRecoveryEmail,
  checkNewPassword,
  validateResetForm,
  nextRecoveryStep,
  NEUTRAL_RESET_NOTICE,
  RESET_SUCCESS_NOTICE,
  RESET_MIN_PASSWORD_LENGTH,
  type RecoveryStep,
} from '../src/lib/passwordRecovery.ts';
import {
  mapPasswordResetError,
  isResetTokenInvalidError,
  isAccountRecoveryCandidateError,
  mapGoogleAuthError,
} from '../src/lib/authErrorMapping.ts';
import { authRepository } from '../src/repositories/AuthRepository.ts';
import { readFileSync } from 'node:fs';

// ============================================================================
// Password recovery flow tests (fictitious data only, no live services).
// ============================================================================

const FAKE_TOKEN = 'Zk3p9-_AbCdEf0123456789xyzQ';

// ---- Token extraction ------------------------------------------------------

test('extractResetToken: bare token is trimmed and returned', () => {
  assert.equal(extractResetToken(`  ${FAKE_TOKEN}\n`), FAKE_TOKEN);
});

test('extractResetToken: nexus:// deep link yields only the token', () => {
  assert.equal(extractResetToken(`nexus://reset-password?token=${FAKE_TOKEN}`), FAKE_TOKEN);
});

test('extractResetToken: https URL with extra params and fragment', () => {
  assert.equal(
    extractResetToken(`https://nexus.example/reset?utm=a&token=${FAKE_TOKEN}&x=1#frag`),
    FAKE_TOKEN
  );
  assert.equal(extractResetToken(`https://nexus.example/reset#token=${FAKE_TOKEN}`), FAKE_TOKEN);
});

test('extractResetToken: percent-encoded token is decoded', () => {
  assert.equal(extractResetToken('nexus://reset-password?token=ab%2Bcd%3D'), 'ab+cd=');
});

test('extractResetToken: link without token and garbage yield empty string', () => {
  assert.equal(extractResetToken('nexus://reset-password'), '');
  assert.equal(extractResetToken('https://nexus.example/reset?foo=bar'), '');
  assert.equal(extractResetToken(''), '');
  assert.equal(extractResetToken('   '), '');
  assert.equal(extractResetToken('a'.repeat(600)), '');
  assert.equal(extractResetToken(undefined as unknown as string), '');
});

test('extractResetToken: result never contains the surrounding URL', () => {
  const out = extractResetToken(`nexus://reset-password?token=${FAKE_TOKEN}`);
  assert.equal(out.includes('nexus://'), false);
  assert.equal(out.includes('token='), false);
});

// ---- Validation ------------------------------------------------------------

test('isValidRecoveryEmail', () => {
  assert.equal(isValidRecoveryEmail('alice@nexus.chat'), true);
  assert.equal(isValidRecoveryEmail('  alice@nexus.chat '), true);
  assert.equal(isValidRecoveryEmail('alice'), false);
  assert.equal(isValidRecoveryEmail('a b@c'), false);
  assert.equal(isValidRecoveryEmail(''), false);
});

test('checkNewPassword: min length and match are tracked independently', () => {
  assert.equal(RESET_MIN_PASSWORD_LENGTH, 8);
  assert.deepEqual(checkNewPassword('1234567', '1234567'), { minLength: false, matches: true, valid: false });
  assert.deepEqual(checkNewPassword('12345678', '1234567x'), { minLength: true, matches: false, valid: false });
  assert.deepEqual(checkNewPassword('12345678', '12345678'), { minLength: true, matches: true, valid: true });
  assert.deepEqual(checkNewPassword('', ''), { minLength: false, matches: false, valid: false });
});

test('validateResetForm: order of blocking messages', () => {
  assert.match(validateResetForm('', 'abcdefgh', 'abcdefgh')!, /código ou link/);
  assert.match(validateResetForm(FAKE_TOKEN, 'abc', 'abc')!, /mínimo 8/);
  assert.match(validateResetForm(FAKE_TOKEN, 'abcdefgh', 'abcdefgX')!, /não coincidem/);
  assert.equal(validateResetForm(FAKE_TOKEN, 'abcdefgh', 'abcdefgh'), null);
});

// ---- Error mapping ---------------------------------------------------------

test('mapPasswordResetError: RESET_TOKEN_INVALID_OR_EXPIRED', () => {
  const raw = 'RESET_TOKEN_INVALID_OR_EXPIRED: Token inválido ou expirado.';
  const msg = mapPasswordResetError(raw);
  assert.match(msg, /inválido|expirou/);
  assert.match(msg, /novo código/);
  assert.equal(msg.includes('RESET_TOKEN'), false);
  assert.equal(isResetTokenInvalidError(raw), true);
  assert.equal(isResetTokenInvalidError(new Error(raw)), true);
  assert.equal(isResetTokenInvalidError('RESET_PASSWORD_WEAK: x'), false);
});

test('mapPasswordResetError: RESET_PASSWORD_WEAK, rate limit, network and generic', () => {
  assert.match(mapPasswordResetError('RESET_PASSWORD_WEAK: fraca'), /muito fraca.*8 caracteres/);
  assert.match(mapPasswordResetError(new Error('RATE_LIMITED: x')), /Muitas tentativas/);
  assert.match(mapPasswordResetError('Falha de conexão com o servidor NEXUS: boom'), /conectar ao servidor/);
  assert.equal(mapPasswordResetError('SOME_CODE: Mensagem clara'), 'Mensagem clara');
  assert.equal(mapPasswordResetError('Erro puro'), 'Erro puro');
});

test('mapPasswordResetError never echoes the token', () => {
  const msg = mapPasswordResetError(`RESET_TOKEN_INVALID_OR_EXPIRED: Token inválido`);
  assert.equal(msg.includes(FAKE_TOKEN), false);
});

test('isAccountRecoveryCandidateError: conflict + unlinked identity offer recovery', () => {
  assert.equal(isAccountRecoveryCandidateError('ACCOUNT_CONFLICT_EMAIL_EXISTS: x'), true);
  assert.equal(isAccountRecoveryCandidateError(new Error('GOOGLE_IDENTITY_NOT_LINKED: x')), true);
  assert.equal(isAccountRecoveryCandidateError('INVALID_OAUTH_TOKEN: x'), false);
  assert.equal(isAccountRecoveryCandidateError(null), false);
});

test('Google error mapping stays unchanged for existing codes', () => {
  assert.match(mapGoogleAuthError('OAUTH_ACCOUNT_ALREADY_LINKED: x'), /já está vinculada/);
});

// ---- State machine ---------------------------------------------------------

test('recovery step transitions cover all 3 screens', () => {
  let s: RecoveryStep = 'forgot_request';
  s = nextRecoveryStep(s, 'requested');
  assert.equal(s, 'reset_password');
  s = nextRecoveryStep(s, 'needNewCode');
  assert.equal(s, 'forgot_request');
  s = nextRecoveryStep(s, 'haveCode');
  assert.equal(s, 'reset_password');
  s = nextRecoveryStep(s, 'succeeded');
  assert.equal(s, 'reset_success');
  // terminal: no further transition
  assert.equal(nextRecoveryStep(s, 'needNewCode'), 'reset_success');
  assert.equal(nextRecoveryStep(s, 'requested'), 'reset_success');
  // cannot succeed straight from the request screen
  assert.equal(nextRecoveryStep('forgot_request', 'succeeded'), 'forgot_request');
});

test('neutral and success notices carry the required security messaging', () => {
  assert.match(NEUTRAL_RESET_NOTICE, /Se o e-mail informado estiver cadastrado/);
  assert.match(NEUTRAL_RESET_NOTICE, /15 minutos/);
  assert.match(NEUTRAL_RESET_NOTICE, /uso único/);
  assert.match(RESET_SUCCESS_NOTICE, /sessões anteriores foram encerradas/);
});

// ---- Repository ↔ Tauri command contract -----------------------------------

test('AuthRepository exposes recovery methods and surfaces backend errors', async () => {
  assert.equal(typeof authRepository.requestPasswordReset, 'function');
  assert.equal(typeof authRepository.verifyResetToken, 'function');
  assert.equal(typeof authRepository.confirmPasswordReset, 'function');
  // Outside Tauri the dynamic import/invoke fails: must reject with an Error, never leak the token.
  await assert.rejects(
    () => authRepository.confirmPasswordReset(FAKE_TOKEN, 'abcdefgh'),
    (err: unknown) => err instanceof Error && !err.message.includes(FAKE_TOKEN)
  );
});

// ---- Static wiring checks (UI + Tauri registration) ------------------------

const read = (p: string) => readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');

test('Tauri commands are defined and registered with the agreed names', () => {
  const auth = read('src-tauri/src/auth.rs');
  const lib = read('src-tauri/src/lib.rs');
  for (const cmd of ['auth_request_password_reset', 'auth_verify_reset_token', 'auth_confirm_password_reset']) {
    assert.match(auth, new RegExp(`pub async fn ${cmd}\\(`), `${cmd} missing in auth.rs`);
    assert.match(lib, new RegExp(`auth::${cmd}`), `${cmd} not registered in lib.rs`);
  }
  assert.match(auth, /\/v1\/auth\/password\/forgot/);
  assert.match(auth, /\/v1\/auth\/password\/verify/);
  assert.match(auth, /\/v1\/auth\/password\/reset/);
  // Success path wipes the local session
  const confirmFn = auth.slice(auth.indexOf('pub async fn auth_confirm_password_reset'));
  assert.match(confirmFn.slice(0, confirmFn.indexOf('#[tauri::command]') > 0 ? confirmFn.indexOf('#[tauri::command]') : undefined), /delete_secure_token\(\)/);
});

test('PasswordRecoveryView renders all required copy and never logs', () => {
  const view = read('src/features/auth/PasswordRecoveryView.tsx');
  for (const text of [
    'Enviar instruções de recuperação',
    'Já possui um código de recuperação?',
    'Voltar ao login',
    'Nova Senha',
    'Confirmar Nova Senha',
    'Solicitar novo código',
    'Fazer login com a nova senha',
    "data-recovery-step=\"reset_success\"",
    "data-recovery-step=\"reset_password\"",
    "data-recovery-step=\"forgot_request\"",
  ]) {
    assert.ok(view.includes(text), `missing: ${text}`);
  }
  assert.equal(/console\.(log|info|debug|warn|error)/.test(view), false, 'must never log');
  assert.equal(/history\.(push|replace)State|location\.(hash|search|href)\s*=/.test(view), false, 'must not touch URL');
  assert.equal(/localStorage|sessionStorage/.test(view), false, 'must not persist secrets');
});

test('AuthView and AuthModal integrate recovery + "Esqueceu sua senha?" entry points', () => {
  for (const f of ['src/features/auth/AuthView.tsx', 'src/features/auth/AuthModal.tsx']) {
    const src = read(f);
    assert.ok(src.includes('PasswordRecoveryView'), `${f}: recovery view not used`);
    assert.ok(src.includes('Esqueceu sua senha?'), `${f}: missing forgot link`);
    assert.ok(src.includes('isAccountRecoveryCandidateError'), `${f}: conflict shortcut missing`);
    assert.ok(src.includes('offerRecovery'), `${f}: error action missing`);
  }
});
