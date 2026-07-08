/**
 * scripts/process-bg.mjs — 캘린더 탭 배경 이미지 전처리 (A/B 비교용 2버전 생성)
 *
 * 입력: scripts/forest-original.jpg (4000x6000, 세로형)
 * 각 변형(VARIANTS)마다: blur → modulate(brightness, saturation) → 가로 폭 2560px
 * 기준으로 리사이즈(원본 가로가 2560 미만이면 업스케일하지 않고 원본 폭 유지) →
 * webp 품질 85 고정으로 인코딩.
 *
 * 가로 폭 기준으로 리사이즈하는 이유: 이 사진은 세로형(4000x6000)인데, 예전처럼
 * "긴 변 1920px" 기준으로 리사이즈하면 짧은 변인 가로가 1280px밖에 안 남아
 * 데스크톱처럼 가로가 넓은 뷰포트에서 background-size:cover가 그 1280px를
 * 업스케일하게 되고, 그 결과가 화면에서 깨져 보였다(실측으로 확인). 가로 폭을
 * 직접 기준으로 잡으면 데스크톱 뷰포트 폭까지 업스케일 없이 커버할 수 있다.
 *
 * 버전 A(기본, forest-calendar.webp): blur 2,  brightness 0.9  — 원본에 가까운 선명함
 * 버전 B(forest-calendar-b.webp):     blur 10, brightness 0.55 — 더 뭉갠 절충안
 * 품질은 더 이상 크기에 맞춰 낮추지 않는다 — 캐시되는 정적 자산 1장이라 500KB까지는
 * 허용하고, 대신 화질을 85로 고정해 리사이즈 해상도 상향에 따른 과압축을 피한다.
 *
 * 실행: node scripts/process-bg.mjs (두 버전 모두 한 번에 생성)
 */

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INPUT        = join(__dirname, 'forest-original.jpg');
const OUTPUT_DIR   = join(__dirname, '..', 'public', 'bg');
const TARGET_WIDTH = 2560; // 가로 폭 기준(긴 변 기준 아님) — 위 주석 참고
const QUALITY      = 85;   // 고정 — 더 이상 크기 맞추려고 낮추지 않음
const MAX_BYTES    = 500 * 1024;

const VARIANTS = [
  { label: 'A', file: 'forest-calendar.webp',   blur: 2,  brightness: 0.9,  saturation: 0.9 },
  { label: 'B', file: 'forest-calendar-b.webp', blur: 10, brightness: 0.55, saturation: 0.7 },
];

async function processVariant({ label, file, blur, brightness, saturation }) {
  const outputPath = join(OUTPUT_DIR, file);

  const { data: buffer, info } = await sharp(INPUT)
    .blur(blur)
    .modulate({ brightness, saturation })
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true }) // height 미지정 → 비율 유지
    .webp({ quality: QUALITY })
    .toBuffer({ resolveWithObject: true });

  writeFileSync(outputPath, buffer);

  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`[process-bg] 버전 ${label} 저장: ${outputPath}`);
  console.log(
    `[process-bg] 버전 ${label} — blur(${blur}) brightness(${brightness}) 해상도=${info.width}x${info.height} ` +
    `quality=${QUALITY} 파일 크기=${kb}KB (상한 500KB)`
  );
  if (buffer.length > MAX_BYTES) {
    console.warn(`[process-bg] 경고: 버전 ${label}이 500KB를 초과했습니다(${kb}KB) — quality나 TARGET_WIDTH를 낮추는 것을 고려하세요.`);
  }
}

async function run() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const variant of VARIANTS) {
    await processVariant(variant);
  }
}

run().catch(e => {
  console.error('[process-bg] 실패:', e.message);
  process.exit(1);
});
