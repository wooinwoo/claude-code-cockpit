// ─── Sprint Presets: React Stack Constraints ───
// AutoBE-inspired: 제약이 품질을 만든다. 스택을 고정하면 에이전트가 "알고" 시작.

/**
 * Detect React project and its toolchain from package.json
 */
export function detectReactProject(pkg) {
  if (!pkg) return null;
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (!deps.react && !deps['react-dom']) return null;
  return {
    preset: REACT_PRESET,
    toolchain: detectToolchain(deps),
  };
}

function detectToolchain(deps) {
  if (deps.next) return 'next';
  if (deps.vite) return 'vite';
  if (deps['react-scripts']) return 'cra';
  return 'vite'; // default
}

// ─── React Preset ───
export const REACT_PRESET = {
  id: 'react',

  // FSD 구조 (고정)
  structure: {
    app: 'src/app/',
    pages: 'src/pages/',
    features: 'src/features/',
    entities: 'src/entities/',
    shared: 'src/shared/',
    widgets: 'src/widgets/',
  },

  // 검증 명령 (툴체인별)
  validation: {
    vite: {
      typecheck: 'npx tsc --noEmit',
      lint: 'npx eslint src/ --ext .ts,.tsx --format json',
      build: 'npx vite build',
      test: 'npx vitest run --reporter=json',
    },
    next: {
      typecheck: 'npx tsc --noEmit',
      lint: 'npx next lint --format json',
      build: 'npx next build',
      test: 'npx vitest run --reporter=json',
    },
    cra: {
      typecheck: 'npx tsc --noEmit',
      lint: 'npx eslint src/ --ext .ts,.tsx --format json',
      build: 'npm run build',
      test: 'npx react-scripts test --watchAll=false --json',
    },
  },

  // 에이전트 프롬프트에 주입할 React 규칙
  promptRules: `
STACK: React + TypeScript + Tailwind CSS + shadcn/ui + Zustand
STRUCTURE: FSD (Feature-Sliced Design)
  src/app/       → 라우팅, 프로바이더, 글로벌 레이아웃
  src/pages/     → 페이지 컴포넌트 (라우트 단위)
  src/features/  → 기능 단위 모듈 (독립적) ★
  src/entities/  → 도메인 모델 (타입, API, 스토어)
  src/shared/    → 공용 UI(shadcn), 유틸, 타입
  src/widgets/   → 조합 컴포넌트

CONVENTIONS:
- Functional components only (class 금지)
- Custom hooks: useXxx, 로직 재사용은 hook으로
- 스타일: Tailwind 유틸리티 클래스만 (CSS 파일 작성 금지)
- UI 컴포넌트: shadcn/ui 우선 사용 (Button, Card, Dialog 등)
  새 shadcn 컴포넌트 필요시: npx shadcn@latest add <name>
- 상태: 로컬=useState, 글로벌=Zustand (또는 프로젝트 기존 패턴)
- Props interface 컴포넌트 파일에 co-locate
- 200줄 넘는 컴포넌트는 분리
- useEffect deps 빠뜨리지 말 것
- features/ 간 직접 import 금지 (shared/를 통해서만)
`.trim(),

  // 리뷰 체크리스트 (LLM 리뷰어에게 주입)
  reviewChecklist: [
    'useEffect dependency array 누락/과잉',
    'Array.map에 key prop 없음',
    'state 직접 변이 (setter 미사용)',
    '3레벨+ prop drilling (context/store 사용 권장)',
    '200줄+ 컴포넌트 (분리 필요)',
    'inline style 객체 매 렌더 재생성',
    'ErrorBoundary 없는 async 데이터 컴포넌트',
    '불필요한 리렌더 (React.memo/useMemo/useCallback 검토)',
    'cleanup 없는 useEffect (구독, 타이머, 이벤트 리스너)',
  ],
};
