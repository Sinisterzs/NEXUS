import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CALL_LAYOUT_PRESETS,
  resolveLayoutMode,
  clampSplitRatio,
  calculateCinemaDimensions,
  shouldSuggestSidebarCollapse,
  getStageContainerClasses,
  formatDetailedFps,
} from '../src/lib/callsLayout.ts';

// ============================================================================
// Testes de Lógica Pura de Layout — Nightly 2 (Chamadas, Modos e Palco)
// ============================================================================

test('resolveLayoutMode: resolve modos explícitos e faz fallback baseado em ratio', () => {
  assert.equal(resolveLayoutMode('compact'), 'compact');
  assert.equal(resolveLayoutMode('balanced'), 'balanced');
  assert.equal(resolveLayoutMode('cinema'), 'cinema');

  // Fallback baseado em ratio numérico
  assert.equal(resolveLayoutMode(null, 45), 'compact');
  assert.equal(resolveLayoutMode(undefined, 50), 'compact');
  assert.equal(resolveLayoutMode(null, 65), 'balanced');
  assert.equal(resolveLayoutMode(null, 75), 'balanced');
  assert.equal(resolveLayoutMode(null, 85), 'cinema');
  assert.equal(resolveLayoutMode(null, 92), 'cinema');

  // Fallback padrão
  assert.equal(resolveLayoutMode(null, undefined), 'balanced');
});

test('clampSplitRatio: limita split ratio dentro do intervalo seguro (30 a 95)', () => {
  assert.equal(clampSplitRatio(10), 30);
  assert.equal(clampSplitRatio(29), 30);
  assert.equal(clampSplitRatio(30), 30);
  assert.equal(clampSplitRatio(68), 68);
  assert.equal(clampSplitRatio(95), 95);
  assert.equal(clampSplitRatio(100), 95);
  assert.equal(clampSplitRatio(68.4), 68);
  assert.equal(clampSplitRatio(68.6), 69);
  assert.equal(clampSplitRatio(NaN), 68);
  assert.equal(clampSplitRatio(Infinity), 68);
});

test('calculateCinemaDimensions: preserva proporção de aspecto (16:9) e calcula letterboxing', () => {
  // Cenário 1: Viewport exatamente 16:9 (1920x1080 com sidebar 0, header 0)
  const exact = calculateCinemaDimensions(1920, 1080, 0, 0, 16 / 9);
  assert.equal(exact.usableWidth, 1920);
  assert.equal(exact.usableHeight, 1080);
  assert.equal(exact.renderWidth, 1920);
  assert.equal(exact.renderHeight, 1080);
  assert.equal(exact.letterboxType, 'exact');

  // Cenário 2: Viewport ultrawide (2560x1080, mais largo que 16:9 -> pillarbox)
  const wide = calculateCinemaDimensions(2560, 1080, 0, 0, 16 / 9);
  assert.equal(wide.usableWidth, 2560);
  assert.equal(wide.usableHeight, 1080);
  assert.equal(wide.renderHeight, 1080);
  assert.equal(wide.renderWidth, 1920); // 1080 * (16/9)
  assert.equal(wide.letterboxType, 'pillarbox');
  assert.ok(wide.renderWidth <= wide.usableWidth);

  // Cenário 3: Viewport vertical ou 4:3 (1200x1200, mais alto que 16:9 -> letterbox)
  const tall = calculateCinemaDimensions(1200, 1200, 0, 0, 16 / 9);
  assert.equal(tall.usableWidth, 1200);
  assert.equal(tall.renderWidth, 1200);
  assert.equal(tall.renderHeight, Math.round(1200 / (16 / 9))); // 675
  assert.equal(tall.letterboxType, 'letterbox');
  assert.ok(tall.renderHeight <= tall.usableHeight);

  // Cenário 4: Desconto de sidebar e header no cálculo da área utilizável
  const withChrome = calculateCinemaDimensions(1920, 1080, 240, 48, 16 / 9);
  assert.equal(withChrome.usableWidth, 1920 - 240); // 1680
  assert.equal(withChrome.usableHeight, 1080 - 48); // 1032
  assert.ok(withChrome.renderWidth <= withChrome.usableWidth);
  assert.ok(withChrome.renderHeight <= withChrome.usableHeight);
});

test('shouldSuggestSidebarCollapse: sugere recolher barra lateral apenas no modo cinema se aberta', () => {
  assert.equal(shouldSuggestSidebarCollapse('cinema', false), true);
  assert.equal(shouldSuggestSidebarCollapse('cinema', true), false);
  assert.equal(shouldSuggestSidebarCollapse('balanced', false), false);
  assert.equal(shouldSuggestSidebarCollapse('compact', false), false);
});

test('getStageContainerClasses: gera classes corretas por modo e preserva tela cheia independente', () => {
  // Tela cheia tem prioridade total e classes dedicadas
  const fsClasses = getStageContainerClasses('cinema', true, true);
  assert.ok(fsClasses.includes('fixed inset-0 z-50 bg-black'));

  // Modo Cinema sem tela cheia ocupa área máxima sem artificial max-w-5xl
  const cinemaClasses = getStageContainerClasses('cinema', false, true);
  assert.ok(cinemaClasses.includes('w-full h-full flex-1 min-h-0'));
  assert.ok(!cinemaClasses.includes('max-w-5xl'));

  // Modo Equilibrado
  const balancedClasses = getStageContainerClasses('balanced', false, true);
  assert.ok(balancedClasses.includes('max-w-6xl'));

  // Modo Compacto
  const compactClasses = getStageContainerClasses('compact', false, true);
  assert.ok(compactClasses.includes('max-w-5xl'));

  // Sem transmissão de tela
  const noStreamClasses = getStageContainerClasses('cinema', false, false);
  assert.ok(noStreamClasses.includes('max-w-4xl'));
});

test('formatDetailedFps: formata telemetria de FPS multi-estágio (solicitado, capturado, enviado, recebido, renderizado)', () => {
  // Vazio / nulo
  const empty = formatDetailedFps(null);
  assert.equal(empty.primaryLabel, '—');
  assert.equal(empty.hasBreakdown, false);

  // Apenas efetivo simples
  const simple = formatDetailedFps({ effective: 30 });
  assert.equal(simple.primaryLabel, '30 FPS');
  assert.equal(simple.hasBreakdown, false);

  // Multi-estágio completo
  const multi = formatDetailedFps({
    requested: 60,
    captured: 59.8,
    sent: 58.2,
    received: 58.0,
    rendered: 57.9,
    effective: 58,
  });
  assert.equal(multi.primaryLabel, '58 FPS');
  assert.equal(multi.hasBreakdown, true);
  assert.ok(multi.secondaryDetails.includes('Cap: 60'));
  assert.ok(multi.secondaryDetails.includes('Env: 58'));
  assert.ok(multi.secondaryDetails.includes('Rec: 58'));
  assert.ok(multi.secondaryDetails.includes('Rend: 58'));
  assert.ok(multi.secondaryDetails.includes('Ped: 60'));
});

test('CALL_LAYOUT_PRESETS: configurações dos presets Compacto, Equilibrado e Cinema', () => {
  assert.equal(CALL_LAYOUT_PRESETS.compact.ratio, 45);
  assert.equal(CALL_LAYOUT_PRESETS.compact.participantCardStyle, 'full');

  assert.equal(CALL_LAYOUT_PRESETS.balanced.ratio, 68);
  assert.equal(CALL_LAYOUT_PRESETS.balanced.participantCardStyle, 'compact');

  assert.equal(CALL_LAYOUT_PRESETS.cinema.ratio, 92);
  assert.equal(CALL_LAYOUT_PRESETS.cinema.participantCardStyle, 'strip');
  assert.equal(CALL_LAYOUT_PRESETS.cinema.controlsOverlay, true);
});
