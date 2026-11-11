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

test('mapPasswordResetError: RESET_TOKEN_INVALID_OR_EXPIRED, RESET_TOKEN_INVALID, RESET_TOKEN_EXPIRED', () => {
  const raw = 'RESET_TOKEN_INVALID_OR_EXPIRED: Token inválido ou expirado.';
  const msg = mapPasswordResetError(raw);
  assert.match(msg, /inválido|expirou/);
  assert.match(msg, /novo código/);
  assert.equal(msg.includes('RESET_TOKEN'), false);
  assert.equal(isResetTokenInvalidError(raw), true);
  assert.equal(isResetTokenInvalidError(new Error(raw)), true);
  assert.equal(isResetTokenInvalidError('RESET_PASSWORD_WEAK: x'), false);

  assert.equal(
    mapPasswordResetError('RESET_TOKEN_INVALID: token inválido'),
    'Código inválido ou já utilizado.'
  );
  assert.equal(isResetTokenInvalidError('RESET_TOKEN_INVALID: token inválido'), true);

  assert.equal(
    mapPasswordResetError('RESET_TOKEN_EXPIRED: token expirado'),
    'Este código expirou (validade de 15 minutos). Solicite um novo.'
  );
  assert.equal(isResetTokenInvalidError('RESET_TOKEN_EXPIRED: token expirado'), true);
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
    assert.ok(src.includes('takePendingResetToken'), `${f}: missing startup deep-link consumption`);
    assert.ok(src.includes('onDeepLinkResetToken'), `${f}: missing live deep-link listener`);
  }
});

test('HTTPS bridge URL (#token= and ?token=) and desktop nexus:// deep-link integration', () => {
  const token64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  assert.equal(
    extractResetToken(`https://nexus-api.dynv6.net/reset-password#token=${token64}`),
    token64
  );
  assert.equal(
    extractResetToken(`https://nexus-api.dynv6.net/reset-password?token=${token64}`),
    token64
  );
  assert.equal(
    extractResetToken(`nexus://reset-password?token=${token64}`),
    token64
  );

  // Desktop protocol registration (NSIS + runtime HKCU\Software\Classes\nexus)
  const hooksNsh = read('src-tauri/nsis/hooks.nsh');
  assert.ok(hooksNsh.includes('Software\\Classes\\nexus'));
  assert.ok(hooksNsh.includes('URL Protocol'));
  assert.ok(hooksNsh.includes('ReadRegStr $0 SHCTX "Software\\Classes\\nexus\\shell\\open\\command" ""'));
  assert.ok(hooksNsh.includes('StrCmp $0 \'"$INSTDIR\\${MAINBINARYNAME}.exe" "%1"\''));

  const tauriConf = read('src-tauri/tauri.conf.json');
  assert.ok(tauriConf.includes('"installerHooks": "nsis/hooks.nsh"'));

  const deeplinkRs = read('src-tauri/src/deeplink.rs');
  assert.ok(deeplinkRs.includes('extract_deep_link_reset_token'));
  assert.ok(deeplinkRs.includes('try_forward_to_running_instance'));
  assert.ok(deeplinkRs.includes('start_ipc_listener'));
  assert.ok(deeplinkRs.includes('ensure_windows_protocol_registered'));

  // Backend HTTPS bridge page and Gmail-safe link generation
  const emailRs = read('nexus-server/src/services/email.rs');
  assert.ok(emailRs.includes('password_reset_bridge_html'));
  assert.ok(emailRs.includes('Abrir no aplicativo NEXUS'));
  assert.ok(emailRs.includes('Copiar código de recuperação'));
  assert.ok(emailRs.includes('window.history.replaceState'));
});

test('Bridge page DOM script displays 64-char code, scrubs URL history, and copies exact token', async () => {
  const vm = await import('node:vm');
  const emailRs = read('nexus-server/src/services/email.rs');
  const scriptMatch = emailRs.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'Bridge script must exist in email.rs');
  const bridgeScript = scriptMatch[1];

  const runBridgeDom = (initialHash: string, initialSearch = '') => {
    const elements: Record<string, any> = {
      'valid-section': { style: { display: 'block' } },
      'missing-section': { style: { display: 'none' } },
      'open-nexus-app': {
        href: 'nexus://reset-password',
        setAttribute(k: string, v: string) {
          this[k] = v;
        },
      },
      'manual-token-value': { textContent: '' },
      'copy-token-btn': {
        textContent: 'Copiar código de recuperação',
        listeners: {} as Record<string, () => void>,
        addEventListener(ev: string, fn: () => void) {
          this.listeners[ev] = fn;
        },
      },
    };
    let replacedUrl: string | null = null;
    let clipboardText: string | null = null;
    let scheduledRedirect: string | null = null;
    const windowObj = {
      location: {
        pathname: '/reset-password',
        hash: initialHash,
        search: initialSearch,
        href: 'https://nexus-api.dynv6.net/reset-password' + initialSearch + initialHash,
      },
      history: {
        replaceState(_s: unknown, _t: string, url: string) {
          replacedUrl = url;
          windowObj.location.hash = '';
          windowObj.location.search = '';
        },
      },
    };
    const ctx = {
      window: windowObj,
      document: {
        title: 'NEXUS — Recuperação de Senha',
        getElementById(id: string) {
          return elements[id];
        },
      },
      navigator: {
        clipboard: {
          writeText(t: string) {
            clipboardText = t;
            return {
              then(cb: () => void) {
                cb();
              },
            };
          },
        },
      },
      URLSearchParams,
      encodeURIComponent,
      setTimeout(fn: () => void, ms: number) {
        if (ms === 150) {
          fn();
          scheduledRedirect = windowObj.location.href;
        }
      },
    };
    vm.runInNewContext(bridgeScript, ctx);
    if (elements['copy-token-btn'].listeners.click) {
      elements['copy-token-btn'].listeners.click();
    }
    return { elements, replacedUrl, clipboardText, scheduledRedirect, finalHash: windowObj.location.hash };
  };

  const token64 = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const validRun = runBridgeDom('#token=' + token64);
  assert.equal(validRun.replacedUrl, '/reset-password');
  assert.equal(validRun.finalHash, '');
  assert.equal(validRun.elements['open-nexus-app'].href, `nexus://reset-password?token=${token64}`);
  assert.equal(validRun.elements['manual-token-value'].textContent, token64);
  assert.equal(validRun.elements['manual-token-value'].textContent.length, 64);
  assert.equal(validRun.clipboardText, token64);
  assert.equal(validRun.elements['copy-token-btn'].textContent, 'Código copiado!');
  assert.equal(validRun.scheduledRedirect, `nexus://reset-password?token=${token64}`);

  const invalidRun = runBridgeDom('#token=bad<script>alert(1)</script>');
  assert.equal(invalidRun.elements['valid-section'].style.display, 'none');
  assert.equal(invalidRun.elements['missing-section'].style.display, 'block');
  assert.equal(invalidRun.scheduledRedirect, null);
});
