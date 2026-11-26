import { useCallback, useEffect, useRef } from 'react';
import {
  useBeforeUnload,
  useBlocker,
  useLocation,
  useSearchParams,
  type BlockerFunction,
} from 'react-router-dom';
import { createUnsavedNavigationGuard } from '../utils/unsaved-navigation';

// ISSUE-12 波 5 单元 5.1：未保存导航守卫自 web/src/pages/AgentProfilesPage.tsx
// 原文搬运（原 202-220 的 navigationGuardRef/setAllowedSearchParams 与
// 550-588 的 shouldBlockNavigation/useBlocker/useBeforeUnload/阻断确认效应/
// ?create=1 路由效应）。两处留痕适配：①hasUnsavedChanges 经 getter 注入
// （页面该值在 hook 调用点之后才算出，两个回调体内改为惰性取值、deps 数组
// 相应改 [getHasUnsavedChanges]——阻断判定与 beforeunload 语义逐字节等价，
// 仅回调重建频率由值变化驱动改为每渲染，useBlocker/useBeforeUnload 行为
// 无差）；②?create=1 效应的 requestBlankDraft 经参数注入（页面状态声明
// 先于本 hook 调用点，见页面内接线注释）。其余搬运体逐字节一致。

export interface UseUnsavedNavigationGuardInput {
  getHasUnsavedChanges: () => boolean;
  searchParams: URLSearchParams;
  requestBlankDraft: () => void;
}

export function useUnsavedNavigationGuard(
  input: UseUnsavedNavigationGuardInput,
) {
  const { getHasUnsavedChanges, searchParams, requestBlankDraft } = input;
  const location = useLocation();
  const [, setSearchParams] = useSearchParams();
  const navigationGuardRef = useRef(createUnsavedNavigationGuard());
  const setAllowedSearchParams = useCallback(
    (
      next: URLSearchParams | Record<string, string>,
      options: { replace?: boolean } = {},
    ) => {
      const normalized =
        next instanceof URLSearchParams ? next : new URLSearchParams(next);
      const serialized = normalized.toString();
      const token = navigationGuardRef.current.allowNext({
        pathname: location.pathname,
        search: serialized ? `?${serialized}` : '',
        hash: '',
      });
      setSearchParams(next, options);
      queueMicrotask(() => navigationGuardRef.current.cancelAllowance(token));
    },
    [location.pathname, setSearchParams],
  );

  const shouldBlockNavigation = useCallback<BlockerFunction>(
    ({ currentLocation, nextLocation }) => {
      const hasUnsavedChanges = getHasUnsavedChanges();
      return navigationGuardRef.current.shouldBlock(
        hasUnsavedChanges,
        currentLocation,
        nextLocation,
      );
    },
    [getHasUnsavedChanges],
  );
  const navigationBlocker = useBlocker(shouldBlockNavigation);

  useBeforeUnload(
    useCallback(
      (event) => {
        const hasUnsavedChanges = getHasUnsavedChanges();
        if (!hasUnsavedChanges) return;
        event.preventDefault();
        event.returnValue = '';
      },
      [getHasUnsavedChanges],
    ),
  );

  useEffect(() => {
    if (navigationBlocker.state !== 'blocked') return;
    if (confirm('当前智能体有未保存修改，离开页面会丢失。是否继续？')) {
      navigationBlocker.proceed();
    } else {
      navigationBlocker.reset();
    }
  }, [navigationBlocker]);

  useEffect(() => {
    if (searchParams.get('create') !== '1') return;
    const next = new URLSearchParams(searchParams);
    next.delete('create');
    requestBlankDraft();
    setAllowedSearchParams(next, { replace: true });
  }, [searchParams, setAllowedSearchParams, requestBlankDraft]);

  return { setAllowedSearchParams };
}
