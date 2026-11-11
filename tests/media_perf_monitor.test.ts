import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaPerfMonitor } from '../src/services/MediaPerfMonitor.ts';

test('MediaPerfMonitor: ciclo de vida de ativação, desativação e reset de métricas', () => {
  const monitor = new MediaPerfMonitor();
  assert.equal(monitor.isActive(), false);

  monitor.start();
  assert.equal(monitor.isActive(), true);

  monitor.recordLongTask(65.5);
  monitor.recordLongTask(120.2);

  const snap = monitor.getSnapshot();
  assert.equal(snap.isEnabled, true);
  assert.equal(snap.longTasks.totalLongTasks, 2);
  assert.equal(snap.longTasks.maxDurationMs, 120.2);
  assert.equal(snap.longTasks.totalDurationMs, 185.7);
  assert.equal(snap.longTasks.recentLongTasksCount, 2);

  monitor.reset();
  const resetSnap = monitor.getSnapshot();
  assert.equal(resetSnap.longTasks.totalLongTasks, 0);
  assert.equal(resetSnap.longTasks.maxDurationMs, 0);
  assert.equal(resetSnap.longTasks.totalDurationMs, 0);
  assert.equal(resetSnap.longTasks.recentLongTasksCount, 0);

  monitor.stop();
  assert.equal(monitor.isActive(), false);
  monitor.destroy();
});

test('MediaPerfMonitor: controle de cadência de polling e proteção contra reentrância', async () => {
  const monitor = new MediaPerfMonitor({
    activePollIntervalMs: 1500,
    idlePollIntervalMs: 4000,
  });

  assert.equal(monitor.getRecommendedPollInterval(true, true), 1500);
  assert.equal(monitor.getRecommendedPollInterval(false, true), 4000);
  assert.equal(monitor.getRecommendedPollInterval(true, false), 4000);

  let runCount = 0;
  const slowPoll = async () => {
    runCount++;
    await new Promise((resolve) => setTimeout(resolve, 50));
    return 'ok';
  };

  // Dispara dois polls concorrentes - o segundo deve ser rejeitado/ignorado
  const [res1, res2] = await Promise.all([
    monitor.executeSafePoll(slowPoll),
    monitor.executeSafePoll(slowPoll),
  ]);

  assert.equal(res1, 'ok');
  assert.equal(res2, null, 'Poll concorrente deve ser ignorado para evitar sobrecarga de CPU');
  assert.equal(runCount, 1);

  monitor.destroy();
});

test('MediaPerfMonitor: extração de estatísticas de codificador e detecção de gargalo de CPU', () => {
  const monitor = new MediaPerfMonitor({
    highCpuThresholdMs: 20.0,
  });
  monitor.start();

  const fakeReport = [
    {
      id: 'outbound-video-1',
      type: 'outbound-rtp',
      kind: 'video',
      encoderImplementation: 'libvpx',
      powerEfficientEncoder: false,
      qualityLimitationReason: 'cpu',
      qualityLimitationDurations: {
        cpu: 14.5,
        bandwidth: 0.2,
        other: 0,
        none: 5.1,
      },
      framesEncoded: 60,
      framesPerSecond: 30,
      totalEncodeTime: 1.5, // 1500ms / 60 frames = 25ms por quadro
      keyFramesEncoded: 2,
      framesDropped: 8,
    },
  ];

  const metrics = monitor.parseRtcStats(fakeReport);
  assert.ok(metrics);
  assert.equal(metrics.encoderImplementation, 'libvpx');
  assert.equal(metrics.powerEfficientEncoder, false);
  assert.equal(metrics.qualityLimitationReason, 'cpu');
  assert.equal(metrics.framesEncoded, 60);
  assert.equal(metrics.framesPerSecond, 30);
  assert.equal(metrics.avgEncodeTimeMs, 25);
  assert.equal(metrics.cpuBottleneckDetected, true, 'Deve detectar gargalo de CPU quando qualityLimitationReason é cpu ou tempo médio alto');

  // Teste de hardware encoder sem limitação de CPU
  const hwReport = [
    {
      id: 'outbound-video-2',
      type: 'outbound-rtp',
      kind: 'video',
      encoderImplementation: 'MediaFoundationVideoEncodeAccelerator',
      powerEfficientEncoder: true,
      qualityLimitationReason: 'none',
      framesEncoded: 120,
      framesPerSecond: 60,
      totalEncodeTime: 1.8, // 300ms adicionais para 60 frames = 5ms por quadro
      keyFramesEncoded: 3,
      framesDropped: 0,
    },
  ];

  const hwMetrics = monitor.parseRtcStats(hwReport);
  assert.ok(hwMetrics);
  assert.equal(hwMetrics.encoderImplementation, 'MediaFoundationVideoEncodeAccelerator');
  assert.equal(hwMetrics.powerEfficientEncoder, true);
  assert.equal(hwMetrics.qualityLimitationReason, 'none');
  assert.equal(hwMetrics.avgEncodeTimeMs, 5);
  assert.equal(hwMetrics.cpuBottleneckDetected, false, 'Hardware encoder rápido não deve sinalizar gargalo de CPU');

  monitor.destroy();
});
