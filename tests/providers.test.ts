import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildMeshyBody, createMeshyProvider, mapMeshyTask } from '../server/providers/meshy.ts';
import { createTripoProvider, mapTripoTask, tripoMultiviewInputs, tripoQualityParams } from '../server/providers/tripo.ts';
import { createDemoProvider } from '../server/providers/demo.ts';
import type { InputImage } from '../server/providers/types.ts';

const jpg = (view: InputImage['view']): InputImage => ({
  view,
  mime: 'image/jpeg',
  data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]),
});

afterEach(() => vi.unstubAllGlobals());

describe('Meshy', () => {
  it('usa image-to-3d com Meshy 7 Ultra, PBR e textura 4K para uma foto', () => {
    const body = buildMeshyBody([jpg('front')], 'ultra');
    expect(body.image_url).toMatch(/^data:image\/jpeg;base64,/);
    expect(body).toMatchObject({
      ai_model: 'meshy-7',
      ultra_mode: true,
      enable_pbr: true,
      should_texture: true,
      texture_resolution: '4k',
      should_remesh: false,
      target_formats: ['glb'],
    });
    // Parâmetros exclusivos do Meshy 6 não devem ir junto com meshy-7.
    expect(body).not.toHaveProperty('remove_lighting');
    expect(body).not.toHaveProperty('image_enhancement');
  });

  it('usa image_urls e não envia ultra_mode com várias fotos', () => {
    const body = buildMeshyBody([jpg('front'), jpg('left'), jpg('back')], 'ultra');
    expect(body.image_urls).toHaveLength(3);
    expect(body).not.toHaveProperty('image_url');
    expect(body).not.toHaveProperty('ultra_mode');
  });

  it('preset econômico usa meshy-5 com remesh e sem texture_resolution', () => {
    const body = buildMeshyBody([jpg('front')], 'fast');
    expect(body).toMatchObject({ ai_model: 'meshy-5', should_remesh: true, target_polycount: 50_000 });
    expect(body).not.toHaveProperty('texture_resolution');
  });

  it('mapeia os estados da tarefa', () => {
    expect(mapMeshyTask({ id: 't', status: 'PENDING', preceding_tasks: 2 })).toMatchObject({
      status: 'pending',
      stage: 'Na fila da Meshy (2 tarefas à frente)',
    });
    expect(mapMeshyTask({ id: 't', status: 'IN_PROGRESS', progress: 72 })).toMatchObject({ status: 'running', progress: 72 });
    expect(
      mapMeshyTask({
        id: 't',
        status: 'SUCCEEDED',
        progress: 100,
        model_urls: { glb: 'https://x/m.glb' },
        thumbnail_url: 'https://x/t.png',
        consumed_credits: 35,
      }),
    ).toEqual({
      status: 'succeeded',
      progress: 100,
      stage: 'Modelo pronto',
      modelUrl: 'https://x/m.glb',
      thumbnailUrl: 'https://x/t.png',
      credits: 35,
    });
    expect(mapMeshyTask({ id: 't', status: 'FAILED', task_error: { message: 'bad image' } })).toMatchObject({
      status: 'failed',
      error: 'Meshy: bad image',
    });
  });

  it('cria a tarefa com Bearer e consulta no mesmo endpoint', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, init });
        if (init.method === 'POST') return new Response(JSON.stringify({ result: 'task-1' }), { status: 202 });
        return new Response(JSON.stringify({ id: 'task-1', status: 'IN_PROGRESS', progress: 40 }));
      }),
    );
    const meshy = createMeshyProvider('msy_test');
    const ref = await meshy.start([jpg('front'), jpg('back')], 'balanced');
    expect(ref).toEqual({ taskId: 'task-1', mode: '/openapi/v1/multi-image-to-3d' });
    expect(calls[0].url).toBe('https://api.meshy.ai/openapi/v1/multi-image-to-3d');
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer msy_test');
    const poll = await meshy.poll(ref);
    expect(calls[1].url).toBe('https://api.meshy.ai/openapi/v1/multi-image-to-3d/task-1');
    expect(poll).toMatchObject({ status: 'running', progress: 40 });
  });

  it('traduz erro 402 em mensagem de créditos', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ message: 'Insufficient credits' }), { status: 402 })));
    await expect(createMeshyProvider('k').start([jpg('front')], 'ultra')).rejects.toThrow(/créditos insuficientes/);
  });

  it('recusa quando não há chave', async () => {
    await expect(createMeshyProvider(undefined).start([jpg('front')], 'ultra')).rejects.toThrow(/MESHY_API_KEY/);
  });
});

describe('Tripo', () => {
  it('monta as 4 posições do multivista na ordem frente, esquerda, trás, direita', () => {
    expect(tripoMultiviewInputs({ front: 'a', back: 'c' })).toEqual([{ file_token: 'a' }, '', { file_token: 'c' }, '']);
  });

  it('não envia geometry_quality para a v2.5', () => {
    expect(tripoQualityParams('fast')).not.toHaveProperty('geometry_quality');
    expect(tripoQualityParams('ultra')).toMatchObject({ model: 'v3.1-20260211', pbr: true, geometry_quality: 'detailed' });
  });

  it('prefere o modelo PBR e trata estados terminais', () => {
    expect(
      mapTripoTask({
        task_id: 't',
        status: 'success',
        output: { pbr_model: 'https://x/pbr.glb', model: 'https://x/m.glb', rendered_image_url: 'https://x/r.webp' },
        credits_consumed: '40.00',
      }),
    ).toMatchObject({ status: 'succeeded', modelUrl: 'https://x/pbr.glb', thumbnailUrl: 'https://x/r.webp', credits: 40 });
    expect(mapTripoTask({ task_id: 't', status: 'banned' }).status).toBe('failed');
    expect(mapTripoTask({ task_id: 't', status: 'unknown' }).status).toBe('running');
  });

  it('faz upload de cada foto e cria a tarefa multivista', async () => {
    const calls: { url: string; body: unknown }[] = [];
    let token = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, body: init.body });
        if (url.endsWith('/files')) return Response.json({ code: 0, data: { file_token: `tok-${++token}` } });
        return Response.json({ code: 0, data: { task_id: 'tripo-1' } });
      }),
    );
    const tripo = createTripoProvider('tsk_test');
    const ref = await tripo.start([jpg('front'), jpg('right')], 'balanced');
    expect(ref).toEqual({ taskId: 'tripo-1', mode: 'multiview-to-model' });
    expect(calls.filter((c) => c.url.endsWith('/files'))).toHaveLength(2);
    const create = calls.at(-1)!;
    expect(create.url).toBe('https://openapi.tripo3d.ai/v3/generation/multiview-to-model');
    expect(JSON.parse(create.body as string).inputs).toEqual([{ file_token: 'tok-1' }, '', '', { file_token: 'tok-2' }]);
  });

  it('exige a foto da frente no multivista', async () => {
    vi.stubGlobal('fetch', vi.fn());
    await expect(createTripoProvider('k').start([jpg('left'), jpg('back')], 'ultra')).rejects.toThrow(/frente/);
  });

  it('trata code != 0 no envelope como erro', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 2010, message: 'invalid image', suggestion: 'use jpg' })));
    await expect(createTripoProvider('k').poll({ taskId: 'x', mode: 'image-to-model' })).rejects.toThrow(
      'Tripo: invalid image — use jpg',
    );
  });
});

describe('Demonstração', () => {
  it('progride com o tempo e conclui com o carro de exemplo', async () => {
    let now = 1_000;
    const demo = createDemoProvider(() => now);
    const ref = await demo.start([jpg('front')], 'balanced');
    now += 4_500;
    expect(await demo.poll(ref)).toMatchObject({ status: 'running', progress: 50 });
    now += 10_000;
    const done = await demo.poll(ref);
    expect(done.status).toBe('succeeded');
    const glb = await demo.download(done.modelUrl!);
    expect(glb.toString('ascii', 0, 4)).toBe('glTF');
  });
});
