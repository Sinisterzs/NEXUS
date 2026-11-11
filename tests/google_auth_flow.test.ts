import test from 'node:test';
import assert from 'node:assert/strict';
import { mapGoogleAuthError } from '../src/lib/authErrorMapping.ts';
import { normalizeAuthUser } from '../src/repositories/AuthRepository.ts';

// ============================================================================
// Frontend Google Authentication Flow & Error Mapping Tests
// Uses fictitious identities and mocked error payloads (no live services).
// ============================================================================

test('Google Login Error: GOOGLE_IDENTITY_NOT_LINKED for passwordless accounts', () => {
  // Fictitious Google-only account without password
  const rawBackendError =
    'GOOGLE_IDENTITY_NOT_LINKED: Este e-mail já está associado a uma conta que não pode ser acessada com este login Google. Contate o suporte.';

  // 1. In AuthView context
  const viewError = mapGoogleAuthError(rawBackendError, 'view');
  assert.equal(
    viewError,
    'Este e-mail pertence a uma conta NEXUS sem senha não vinculada a este login Google. Por segurança, o vínculo automático não é permitido. Entre em contato com o suporte para assistência.'
  );
  // CRITICAL SECURITY ASSERTION: Must never instruct user to log in with password
  assert.equal(
    viewError.includes('faça login com sua senha'),
    false,
    'Passwordless accounts must NEVER be instructed to use a password'
  );

  // 2. In AuthModal context
  const modalError = mapGoogleAuthError(rawBackendError, 'modal');
  assert.equal(
    modalError,
    'Este e-mail pertence a uma conta NEXUS sem senha não vinculada a este login Google. Por segurança, o vínculo automático não é permitido. Entre em contato com o suporte para assistência.'
  );
  assert.equal(modalError.includes('faça login com sua senha'), false);

  // 3. Works when wrapped inside an Error object
  const wrappedError = new Error(rawBackendError);
  assert.equal(
    mapGoogleAuthError(wrappedError, 'view'),
    'Este e-mail pertence a uma conta NEXUS sem senha não vinculada a este login Google. Por segurança, o vínculo automático não é permitido. Entre em contato com o suporte para assistência.'
  );
});

test('Google Login Error: ACCOUNT_CONFLICT_EMAIL_EXISTS for accounts with password', () => {
  const rawBackendError =
    'ACCOUNT_CONFLICT_EMAIL_EXISTS: Já existe uma conta cadastrada com este e-mail. Para vincular, faça login com sua senha.';

  // 1. In AuthView context
  const viewError = mapGoogleAuthError(rawBackendError, 'view');
  assert.equal(
    viewError,
    'Já existe uma conta cadastrada com este e-mail no NEXUS. Faça login com sua senha abaixo para vincular.'
  );

  // 2. In AuthModal context
  const modalError = mapGoogleAuthError(rawBackendError, 'modal');
  assert.equal(
    modalError,
    'Já existe uma conta cadastrada com este e-mail no NEXUS. Por segurança, faça login com sua senha abaixo e vincule sua conta Google nas Configurações.'
  );

  // 3. Fallback compatibility with raw message without error code prefix
  const rawLegacyMsg = 'Já existe uma conta cadastrada com este e-mail. Para vincular, faça login com sua senha.';
  assert.equal(
    mapGoogleAuthError(rawLegacyMsg, 'view'),
    'Já existe uma conta cadastrada com este e-mail no NEXUS. Faça login com sua senha abaixo para vincular.'
  );
});

test('Google Login Error: OAUTH_ACCOUNT_ALREADY_LINKED when identity is linked elsewhere', () => {
  const rawErr = 'OAUTH_ACCOUNT_ALREADY_LINKED: Esta conta de provedor já está vinculada a outro usuário.';
  const mapped = mapGoogleAuthError(rawErr);
  assert.equal(mapped, 'Esta conta Google já está vinculada a outro usuário do NEXUS.');
});

test('Google Login Error: INVALID_OAUTH_TOKEN on token rejection or expiration', () => {
  const rawErr = 'INVALID_OAUTH_TOKEN: Token OAuth inválido ou expirado.';
  const mapped = mapGoogleAuthError(rawErr);
  assert.equal(mapped, 'Sessão ou token do Google inválido ou expirado. Tente fazer login novamente.');
});

test('Google Login Error: OAUTH_EMAIL_NOT_VERIFIED when external provider rejects email', () => {
  const rawErr = 'OAUTH_EMAIL_NOT_VERIFIED: O e-mail da conta externa não foi verificado pelo provedor.';
  const mapped = mapGoogleAuthError(rawErr);
  assert.equal(mapped, 'O e-mail da conta Google não foi verificado. Verifique seu e-mail no Google antes de continuar.');
});

test('Google Login Error: generic code prefix is cleanly stripped for unknown backend errors', () => {
  const customErr = 'RATE_LIMITED: Limite de tentativas excedido. Aguarde alguns minutos.';
  const mapped = mapGoogleAuthError(customErr);
  assert.equal(mapped, 'Limite de tentativas excedido. Aguarde alguns minutos.');
});

test('AuthRepository: normalizeAuthUser correctly normalizes fictitious account profiles', () => {
  // Case A: Pre-existing Google account (hasGoogle: true, hasPassword: false)
  const fictitiousGoogleUser = {
    id: 'fictitious-uuid-google-1001',
    username: 'fictitious_google_coder',
    email: 'fictitious.google@example.com',
    display_name: 'Fictitious Google Dev',
    avatar_url: 'https://lh3.googleusercontent.com/mock-avatar',
    has_password: false,
    has_google: true,
    created_at: '2026-11-01T00:00:00.000Z',
  };

  const normalizedGoogle = normalizeAuthUser(fictitiousGoogleUser);
  assert.equal(normalizedGoogle.id, 'fictitious-uuid-google-1001');
  assert.equal(normalizedGoogle.username, 'fictitious_google_coder');
  assert.equal(normalizedGoogle.displayName, 'Fictitious Google Dev');
  assert.equal(normalizedGoogle.hasPassword, false, 'Pre-existing Google user must not have password');
  assert.equal(normalizedGoogle.hasGoogle, true, 'Pre-existing Google user must have hasGoogle true');

  // Case B: Pre-existing Email+Password account (hasGoogle: false, hasPassword: true)
  const fictitiousPasswordUser = {
    id: 'fictitious-uuid-pw-2002',
    username: 'fictitious_pw_user',
    email: 'fictitious.pw@example.com',
    displayName: 'Fictitious Password User',
    hasPassword: true,
    hasGoogle: false,
  };

  const normalizedPw = normalizeAuthUser(fictitiousPasswordUser);
  assert.equal(normalizedPw.hasPassword, true);
  assert.equal(normalizedPw.hasGoogle, false);

  // Case C: Dual authenticated account (both Google and password active)
  const fictitiousDualUser = {
    id: 'fictitious-uuid-dual-3003',
    username: 'fictitious_dual_user',
    email: 'fictitious.dual@example.com',
    has_password: true,
    has_google: true,
  };

  const normalizedDual = normalizeAuthUser(fictitiousDualUser);
  assert.equal(normalizedDual.hasPassword, true);
  assert.equal(normalizedDual.hasGoogle, true);
});

// ============================================================================
// SQL Diagnostic Logic Simulation Tests with Fictitious Data & Legacy Emails
// ============================================================================

interface MockCredentialRow {
  userId: string;
  email: string;
  passwordHash: string | null;
}

interface MockOAuthRow {
  userId: string;
  provider: string;
  providerSubject: string;
}

function simulateSingleAccountDiagnostic(
  targetEmail: string,
  credentials: MockCredentialRow[],
  oauthAccounts: MockOAuthRow[]
) {
  const rawTarget = targetEmail;
  const normTarget = targetEmail.trim().toLowerCase();

  const exactRawMatches = credentials.filter((c) => c.email === rawTarget);
  const exactNormMatches = credentials.filter((c) => c.email === normTarget);
  const normalizedMatches = credentials.filter(
    (c) => c.email.trim().toLowerCase() === normTarget
  );

  const candidateUserIds = Array.from(new Set(normalizedMatches.map((c) => c.userId)));
  const candidateOauth = oauthAccounts.filter((o) => candidateUserIds.includes(o.userId));

  const googleLinks = candidateOauth.filter(
    (o) => o.provider.trim().toLowerCase() === 'google'
  );

  return {
    hasExactRawCredentialsMatch: exactRawMatches.length > 0,
    hasExactNormalizedCredentialsMatch: exactNormMatches.length > 0,
    hasAnyNormalizedCredentialsMatch: normalizedMatches.length > 0,
    countRowsMatchingNormalizedEmail: normalizedMatches.length,
    matchingCredentialsUnnormalizedInDb: normalizedMatches.some(
      (c) => c.email !== c.email.trim().toLowerCase()
    ),
    anyMatchedAccountHasPassword: normalizedMatches.some(
      (c) => typeof c.passwordHash === 'string' && c.passwordHash.length > 0
    ),
    anyMatchedAccountIsPasswordless: normalizedMatches.some(
      (c) => c.passwordHash === null || c.passwordHash.length === 0
    ),
    hasRegisteredGoogleLink: googleLinks.length > 0,
    totalGoogleLinksForMatchedAccounts: googleLinks.length,
    totalOauthLinksAllProviders: candidateOauth.length,
    multipleAccountsShareNormalizedEmail: candidateUserIds.length > 1,
  };
}

test('SQL Diagnostic Simulation: Detects legacy unnormalized email (spaces and mixed-case)', () => {
  // Fictitious legacy row created before normalization enforcement
  const mockCredentials: MockCredentialRow[] = [
    {
      userId: 'usr-fictitious-legacy-1',
      email: '  Legacy.User@Example.COM  ',
      passwordHash: null,
    },
  ];
  const mockOAuth: MockOAuthRow[] = [
    {
      userId: 'usr-fictitious-legacy-1',
      provider: 'google',
      providerSubject: 'google-sub-legacy-999',
    },
  ];

  // Operator queries with clean normalized email
  const diagClean = simulateSingleAccountDiagnostic(
    'legacy.user@example.com',
    mockCredentials,
    mockOAuth
  );

  assert.equal(diagClean.hasExactRawCredentialsMatch, false);
  assert.equal(diagClean.hasExactNormalizedCredentialsMatch, false, 'Must flag that exact normalized string was NOT found');
  assert.equal(diagClean.hasAnyNormalizedCredentialsMatch, true, 'MUST successfully find the row via normalized search');
  assert.equal(diagClean.matchingCredentialsUnnormalizedInDb, true, 'MUST identify that row in DB is unnormalized');
  assert.equal(diagClean.anyMatchedAccountIsPasswordless, true);
  assert.equal(diagClean.hasRegisteredGoogleLink, true);
  assert.equal(diagClean.multipleAccountsShareNormalizedEmail, false);

  // Operator queries with raw email copied from external form
  const diagRaw = simulateSingleAccountDiagnostic(
    '  Legacy.User@Example.COM  ',
    mockCredentials,
    mockOAuth
  );
  assert.equal(diagRaw.hasExactRawCredentialsMatch, true);
  assert.equal(diagRaw.matchingCredentialsUnnormalizedInDb, true);
});

test('SQL Diagnostic Simulation: Distinguishes between registered Google link and sub divergence', () => {
  // Case A: Google link registered, but incoming token sub could differ
  const mockCredentials: MockCredentialRow[] = [
    {
      userId: 'usr-fictitious-google-linked',
      email: 'returning.dev@example.com',
      passwordHash: null,
    },
  ];
  const mockOAuth: MockOAuthRow[] = [
    {
      userId: 'usr-fictitious-google-linked',
      provider: 'google',
      providerSubject: 'sub-original-alpha',
    },
  ];

  const diag = simulateSingleAccountDiagnostic(
    'returning.dev@example.com',
    mockCredentials,
    mockOAuth
  );

  // Factual proofs provided by DB:
  assert.equal(diag.hasRegisteredGoogleLink, true, 'Fact: user has a registered Google row');
  assert.equal(diag.totalGoogleLinksForMatchedAccounts, 1);
  assert.equal(diag.anyMatchedAccountIsPasswordless, true);
  // Important: SQL script outputs only has_registered_google_link.
  // It does NOT claim that 'sub' diverges because tokens are not stored in database.
});

test('SQL Diagnostic Simulation: Identifies multiple accounts colliding on normalized email', () => {
  const mockCredentials: MockCredentialRow[] = [
    {
      userId: 'usr-1',
      email: 'john.doe@example.com',
      passwordHash: 'hash-abc',
    },
    {
      userId: 'usr-2',
      email: 'John.Doe@example.com',
      passwordHash: null,
    },
  ];
  const mockOAuth: MockOAuthRow[] = [];

  const diag = simulateSingleAccountDiagnostic(
    'john.doe@example.com',
    mockCredentials,
    mockOAuth
  );

  assert.equal(diag.hasAnyNormalizedCredentialsMatch, true);
  assert.equal(diag.countRowsMatchingNormalizedEmail, 2);
  assert.equal(diag.multipleAccountsShareNormalizedEmail, true, 'Must detect duplicate accounts sharing normalized email');
  assert.equal(diag.anyMatchedAccountHasPassword, true);
  assert.equal(diag.anyMatchedAccountIsPasswordless, true);
  assert.equal(diag.hasRegisteredGoogleLink, false);
});
