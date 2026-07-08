/**
 * scripts/process-bg.mjs — 캘린더 탭 배경 이미지 전처리
 *
 * 입력:  scripts/forest-original.jpg
 * 처리:  blur(20) → modulate(brightness 0.7, saturation 0.7) → 긴 변 1920px로 리사이즈
 * 출력:  public/bg/forest-calendar.webp (200KB 이하가 될 때까지 webp 품질을 낮춰가며 재인코딩)
 *
 * 실행: node scripts/process-bg.mjs
 */

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT        = join(__dirname, 'forest-original.jpg');
const OUTPUT       = join(__dirname, '..', 'public', 'bg', 'forest-calendar.webp');
const MAX_BYTES    = 200 * 1024;
const LONG_EDGE    = 1920;
const START_QUALITY = 80;
const MIN_QUALITY   = 20;
const QUALITY_STEP  = 10;

async function run() {
  mkdirSync(dirname(OUTPUT), { recursive: true });

  // 블러·모듈레이션·리사이즈(픽셀 연산)는 한 번만 수행하고 raw 픽셀로 받아둔다 —
  // 아래 품질 탐색 루프에서 매번 블러를 다시 계산하지 않고 인코딩만 반복하기 위함.
  const { data, info } = await sharp(INPUT)
    .blur(20)
    .modulate({ brightness: 0.7, saturation: 0.7 })
    .resize({ width: LONG_EDGE, height: LONG_EDGE, fit: 'inside', withoutEnlargement: true })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const rawOpts = { raw: { width: info.width, height: info.height, channels: info.channels } };

  let quality = START_QUALITY;
  let buffer;
  for (; quality >= MIN_QUALITY; quality -= QUALITY_STEP) {
    buffer = await sharp(data, rawOpts).webp({ quality }).toBuffer();
    if (buffer.length <= MAX_BYTES) break;
  }

  writeFileSync(OUTPUT, buffer);

  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`[process-bg] 저장: ${OUTPUT}`);
  console.log(`[process-bg] 해상도: ${info.width}x${info.height}  quality=${quality}  파일 크기=${kb}KB (목표 200KB 이하)`);
  if (buffer.length > MAX_BYTES) {
    console.warn(`[process-bg] 경고: 최저 품질(${MIN_QUALITY})에서도 200KB를 초과했습니다 — LONG_EDGE를 더 줄여보세요.`);
  }
}

run().catch(e => {
  console.error('[process-bg] 실패:', e.message);
  process.exit(1);
});
