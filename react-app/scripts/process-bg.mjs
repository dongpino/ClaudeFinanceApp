/**
 * scripts/process-bg.mjs — 캘린더 탭 배경 이미지 전처리
 *
 * ── 다크 프리셋(A/B 비교용 2버전, 기존 그대로) ──────────────────────────
 * 입력: scripts/forest-original.jpg (4000x6000, 세로형)
 * 각 변형(DARK_VARIANTS)마다: blur → modulate(brightness, saturation) → 가로 폭 2560px
 * 기준으로 리사이즈(원본 가로가 2560 미만이면 업스케일하지 않고 원본 폭 유지) →
 * webp 품질 85 고정으로 인코딩.
 *
 * 가로 폭 기준으로 리사이즈하는 이유: 이 사진은 세로형(4000x6000)인데, 예전처럼
 * "긴 변 1920px" 기준으로 리사이즈하면 짧은 변인 가로가 1280px밖에 안 남아
 * 데스크톱처럼 가로가 넓은 뷰포트에서 background-size:cover가 그 1280px를
 * 업스케일하게 되고, 그 결과가 화면에서 깨져 보였다(실측으로 확인). 가로 폭을
 * 직접 기준으로 잡으면 데스크톱 뷰포트 폭까지 업스케일 없이 커버할 수 있다.
 *
 * 버전 A(기본, forest-calendar.webp): blur 1,  brightness 0.75 — 원본에 가까운 선명함
 *   (2026-07-14: blur 2 → 1로 조정 — 숲 실루엣·나무 결이 또렷해지는 방향. sigma를
 *   낮추면 디테일이 늘어 압축 후 용량도 커진다 — 500KB 상한 안인지 매번 확인할 것.)
 * 버전 B(forest-calendar-b.webp):     blur 10, brightness 0.55 — 더 뭉갠 절충안(미사용, 그대로 둠)
 * 품질은 더 이상 크기에 맞춰 낮추지 않는다 — 캐시되는 정적 자산 1장이라 500KB까지는
 * 허용하고, 대신 화질을 85로 고정해 리사이즈 해상도 상향에 따른 과압축을 피한다.
 *
 * ── 라이트 프리셋(신규, 눈 덮인 숲 — 사진: Tim Kuhn, Unsplash) ───────────
 * 입력: scripts/forest-original-light.jpg (6960x4640, 가로형 — 다크와 반대로
 * 원본 자체가 이미 가로형이라 데스크톱용은 별도 크롭 없이 그대로 리사이즈하면
 * 되고, 모바일 세로 크롭만 별도로 잘라낸다).
 * 다크와 같은 출력 규격(webp, 가로 폭 2560 기준 리사이즈, 500KB 상한 경고)을
 * 따르되, 두 가지가 다르다:
 *   1) blur 2(약하게) — 처음엔 무블러였으나(2026-07-14 조정) 눈 결정 디테일이 너무
 *      또렷해 "눈 숲"이라는 형태감보다 노이즈처럼 읽혔다. 다크와 반대 방향 조정:
 *      다크는 sigma를 낮춰(2→1) 더 또렷하게, 라이트는 sigma를 올려(0→2) 더 은은하게.
 *   2) 데스크톱/모바일 두 벌을 각각 만든다 — 데스크톱은 원본 그대로(이미 가로형),
 *      모바일은 원본 높이를 그대로 두고 폭만 중앙 기준으로 잘라 세로 비율(3:4)을
 *      만든 뒤 리사이즈한다. 모바일 폭은 2560이 아니라 1280 — 세로 크롭이라 실제
 *      화면에 필요한 픽셀이 데스크톱의 절반 이하라 그대로 2560을 쓰면 대역폭 낭비.
 *   3) 리사이즈 후 흰색 30% 오버레이를 합성한다(채도를 낮춰도 사진이 그 자체로
 *      화려해 캘린더 셀 텍스트 대비가 떨어지는 것을 방지하는 시작값 — 실측 후
 *      LIGHT_PRESET.overlayOpacity만 조정하면 됨).
 *
 * 실행: node scripts/process-bg.mjs (다크 A/B + 라이트 데스크톱/모바일 전부 한 번에 생성)
 */

import sharp from 'sharp';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR   = join(__dirname, '..', 'public', 'bg');
const TARGET_WIDTH = 2560; // 가로 폭 기준(긴 변 기준 아님) — 위 주석 참고
const QUALITY      = 85;   // 고정 — 더 이상 크기 맞추려고 낮추지 않음
const MAX_BYTES    = 500 * 1024;

function reportSize(label, outputPath, info, buffer, quality) {
  const kb = (buffer.length / 1024).toFixed(1);
  console.log(`[process-bg] ${label} 저장: ${outputPath}`);
  console.log(
    `[process-bg] ${label} — 해상도=${info.width}x${info.height} quality=${quality} ` +
    `파일 크기=${kb}KB (상한 500KB)`
  );
  if (buffer.length > MAX_BYTES) {
    console.warn(`[process-bg] 경고: ${label}이 500KB를 초과했습니다(${kb}KB) — quality나 리사이즈 폭을 낮추는 것을 고려하세요.`);
  }
}

// ── 다크 프리셋 ──────────────────────────────────────────────────
const DARK_INPUT = join(__dirname, 'forest-original.jpg');

const DARK_VARIANTS = [
  { label: '다크 A', file: 'forest-calendar.webp',   blur: 1,  brightness: 0.75, saturation: 0.9 },
  { label: '다크 B', file: 'forest-calendar-b.webp', blur: 10, brightness: 0.55, saturation: 0.7 },
];

async function processDarkVariant({ label, file, blur, brightness, saturation }) {
  const outputPath = join(OUTPUT_DIR, file);

  const { data: buffer, info } = await sharp(DARK_INPUT)
    .blur(blur)
    .modulate({ brightness, saturation })
    .resize({ width: TARGET_WIDTH, withoutEnlargement: true }) // height 미지정 → 비율 유지
    .webp({ quality: QUALITY })
    .toBuffer({ resolveWithObject: true });

  writeFileSync(outputPath, buffer);
  reportSize(label, outputPath, info, buffer, QUALITY);
}

// ── 라이트 프리셋 ────────────────────────────────────────────────
const LIGHT_INPUT = join(__dirname, 'forest-original-light.jpg');
const LIGHT_MOBILE_WIDTH  = 1280; // 세로 크롭이라 데스크톱(2560)의 절반이면 충분
const LIGHT_MOBILE_ASPECT = 3 / 4; // width/height — 모바일 세로 크롭 목표 비율
// 다크는 blur로 디테일을 죽여 quality 85에서도 작다(실측 60KB대). 라이트는 blur가
// 없어(원본의 눈 결정 디테일을 살리려는 의도) 같은 quality 85에서 2560폭 데스크톱이
// 564KB로 500KB 상한을 넘었다 — quality만 80으로 낮춰 420KB대로 맞춘다(실측,
// 아래 processLightVariant 참고). 해상도/크롭은 그대로 유지.
const LIGHT_QUALITY = 80;

const LIGHT_PRESET = {
  blur: 2,           // 가벼운 블러(2026-07-14 추가) — 눈 결정 디테일을 은은하게 죽이되
                      // "눈 숲" 형태는 유지. 다크(2→1, 더 또렷하게)와 반대 방향 조정.
  brightness: 1.0,   // 원본이 이미 밝은 서리 톤 — 다크와 달리 어둡게 누르지 않는다
  saturation: 0.75,  // 채도 -25%(요구 범위 -20~30%대 중간값)
  overlayOpacity: 0.30, // 흰색 오버레이 30% — 가독성 확보용 시작값, 실측 후 조정
};

const LIGHT_VARIANTS = [
  { label: '라이트 데스크톱', file: 'forest-calendar-light.webp',        targetWidth: TARGET_WIDTH,      crop: false },
  { label: '라이트 모바일',   file: 'forest-calendar-light-mobile.webp', targetWidth: LIGHT_MOBILE_WIDTH, crop: true },
];

async function processLightVariant({ label, file, targetWidth, crop }) {
  const outputPath = join(OUTPUT_DIR, file);

  let pipeline = sharp(LIGHT_INPUT).rotate(); // EXIF 방향 보정
  if (crop) {
    // 세로 크롭(중앙 기준) — 원본이 가로형이라, 높이는 그대로 두고 폭만 중앙에서
    // LIGHT_MOBILE_ASPECT 비율만큼만 잘라내 세로형으로 만든다.
    const { width: srcW, height: srcH } = await sharp(LIGHT_INPUT).metadata();
    const cropW = Math.round(srcH * LIGHT_MOBILE_ASPECT);
    const left  = Math.max(0, Math.round((srcW - cropW) / 2));
    pipeline = pipeline.extract({ left, top: 0, width: cropW, height: srcH });
  }

  const resizedBuffer = await pipeline
    .blur(LIGHT_PRESET.blur)
    .modulate({ brightness: LIGHT_PRESET.brightness, saturation: LIGHT_PRESET.saturation })
    .resize({ width: targetWidth, withoutEnlargement: true })
    .toBuffer();

  const { width, height } = await sharp(resizedBuffer).metadata();

  const { data: buffer, info } = await sharp(resizedBuffer)
    .composite([{
      input: { create: { width, height, channels: 4, background: { r: 255, g: 255, b: 255, alpha: LIGHT_PRESET.overlayOpacity } } },
      blend: 'over',
    }])
    .webp({ quality: LIGHT_QUALITY })
    .toBuffer({ resolveWithObject: true });

  writeFileSync(outputPath, buffer);
  reportSize(label, outputPath, info, buffer, LIGHT_QUALITY);
}

async function run() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  for (const variant of DARK_VARIANTS) {
    await processDarkVariant(variant);
  }
  for (const variant of LIGHT_VARIANTS) {
    await processLightVariant(variant);
  }
}

run().catch(e => {
  console.error('[process-bg] 실패:', e.message);
  process.exit(1);
});
