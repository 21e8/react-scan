import { signal, type Signal } from '@preact/signals';
import {
  createFiberVisitor,
  didFiberCommit,
  getDisplayName,
  getMutatedHostFibers,
  getTimings,
  getType,
  hasMemoCache,
  instrument,
  isValidElement,
  traverseContexts,
  traverseProps,
  traverseState,
} from 'bippy';
import type * as React from 'react';
import type { Fiber, FiberRoot } from 'react-reconciler';
import { isEqual } from 'src/core/utils';
import { getIsProduction, ReactScanInternals, Store } from './index';

let fps = 0;
let lastTime = performance.now();
let frameCount = 0;
let initedFps = false;

const updateFPS = () => {
  frameCount++;
  const now = performance.now();
  if (now - lastTime >= 1000) {
    fps = frameCount;
    frameCount = 0;
    lastTime = now;
  }
  requestAnimationFrame(updateFPS);
};

export const getFPS = () => {
  if (!initedFps) {
    initedFps = true;
    updateFPS();
    fps = 60;
  }

  return fps;
};

export const isElementVisible = (el: Element) => {
  const style = window.getComputedStyle(el);
  return (
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    style.contentVisibility !== 'hidden' &&
    style.opacity !== '0'
  );
};

export const isValueUnstable = (prevValue: unknown, nextValue: unknown) => {
  const prevValueString = fastSerialize(prevValue);
  const nextValueString = fastSerialize(nextValue);
  return (
    prevValueString === nextValueString &&
    unstableTypes.includes(typeof prevValue) &&
    unstableTypes.includes(typeof nextValue)
  );
};

export const isElementInViewport = (
  el: Element,
  rect = el.getBoundingClientRect(),
) => {
  const isVisible =
    rect.bottom > 0 &&
    rect.right > 0 &&
    rect.top < window.innerHeight &&
    rect.left < window.innerWidth;

  return isVisible && rect.width && rect.height;
};

export interface RenderChange {
  type: 'props' | 'context' | 'state';
  name: string;
  prevValue: unknown;
  nextValue: unknown;
  unstable: boolean;
}

// this must grow O(1) w.r.t to renders
export interface AggregatedChange {
  type: Set<'props' | 'context' | 'state'>;
  unstable: boolean;
}

export type Category = 'commit' | 'unstable' | 'unnecessary';

export interface Render {
  phase: 'mount' | 'update' | 'unmount';
  componentName: string | null;
  time: number | null;
  count: number; // uh is this right?
  forget: boolean;
  changes: Array<RenderChange>;
  unnecessary: boolean | null;
  didCommit: boolean;
  fps: number;
}

const unstableTypes = ['function', 'object'];

const cache = new WeakMap<object, string>();

export function fastSerialize(value: unknown, depth = 0): string {
  if (depth < 0) return '…';

  switch (typeof value) {
    case 'function':
      return value.toString();
    case 'string':
      return value;
    case 'number':
    case 'boolean':
    case 'undefined':
      return String(value);
    case 'object':
      break;
    default:
      return String(value);
  }

  if (value === null) return 'null';

  if (cache.has(value)) {
    return cache.get(value)!;
  }

  if (Array.isArray(value)) {
    const str = value.length ? `[${value.length}]` : '[]';
    cache.set(value, str);
    return str;
  }

  if (isValidElement(value)) {
    const type = getDisplayName(value.type) ?? '';
    const propCount = value.props ? Object.keys(value.props).length : 0;
    const str = `<${type} ${propCount}>`;
    cache.set(value, str);
    return str;
  }

  if (Object.getPrototypeOf(value) === Object.prototype) {
    const keys = Object.keys(value);
    const str = keys.length ? `{${keys.length}}` : '{}';
    cache.set(value, str);
    return str;
  }

  const ctor = (value as any).constructor;
  if (ctor && typeof ctor === 'function' && ctor.name) {
    const str = `${ctor.name}{…}`;
    cache.set(value, str);
    return str;
  }

  const tagString = Object.prototype.toString.call(value).slice(8, -1);
  const str = `${tagString}{…}`;
  cache.set(value, str);
  return str;
}

export const getPropsChanges = (fiber: Fiber) => {
  const changes: Array<RenderChange> = [];

  const prevProps = fiber.alternate?.memoizedProps || {};
  const nextProps = fiber.memoizedProps || {};

  const allKeys = new Set([
    ...Object.keys(prevProps),
    ...Object.keys(nextProps),
  ]);
  for (const propName in allKeys) {
    const prevValue = prevProps?.[propName];
    const nextValue = nextProps?.[propName];

    if (
      isEqual(prevValue, nextValue) ||
      isValidElement(prevValue) ||
      isValidElement(nextValue)
    ) {
      continue;
    }
    const change: RenderChange = {
      type: 'props',
      name: propName,
      prevValue,
      nextValue,
      unstable: false,
    };
    changes.push(change);

    if (isValueUnstable(prevValue, nextValue)) {
      change.unstable = true;
    }
  }

  return changes;
};

interface FiberState {
  memoizedState: unknown;
}

function getStateChangesTraversal(
  this: Array<RenderChange>,
  prevState: FiberState,
  nextState: FiberState,
): void {
  if (isEqual(prevState.memoizedState, nextState.memoizedState)) return;
  const change: RenderChange = {
    type: 'state',
    name: '', // bad interface should make this a discriminated union
    prevValue: prevState.memoizedState,
    nextValue: nextState.memoizedState,
    unstable: false,
  };
  this.push(change);
}

export const getStateChanges = (fiber: Fiber) => {
  const changes: Array<RenderChange> = [];

  traverseState(fiber, getStateChangesTraversal.bind(changes));

  return changes;
};

interface FiberContext {
  context: React.Context<unknown>;
  memoizedValue: unknown;
}

function getContextChangesTraversal(
  this: Array<RenderChange>,
  prevContext: FiberContext,
  nextContext: FiberContext,
): void {
  const prevValue = prevContext.memoizedValue;
  const nextValue = nextContext.memoizedValue;

  const change: RenderChange = {
    type: 'context',
    name: '',
    prevValue,
    nextValue,
    unstable: false,
  };
  this.push(change);

  const prevValueString = fastSerialize(prevValue);
  const nextValueString = fastSerialize(nextValue);

  if (
    unstableTypes.includes(typeof prevValue) &&
    unstableTypes.includes(typeof nextValue) &&
    prevValueString === nextValueString
  ) {
    change.unstable = true;
  }
}

export const getContextChanges = (fiber: Fiber) => {
  const changes: Array<RenderChange> = [];

  traverseContexts(fiber, getContextChangesTraversal.bind(changes));

  return changes;
};

type OnRenderHandler = (fiber: Fiber, renders: Array<Render>) => void;
type OnCommitStartHandler = () => void;
type OnCommitFinishHandler = () => void;
type OnErrorHandler = (error: unknown) => void;
type IsValidFiberHandler = (fiber: Fiber) => boolean;
type OnActiveHandler = () => void;

interface InstrumentationConfig {
  onCommitStart: OnCommitStartHandler;
  isValidFiber: IsValidFiberHandler;
  onRender: OnRenderHandler;
  onCommitFinish: OnCommitFinishHandler;
  onError: OnErrorHandler;
  onActive?: OnActiveHandler;
  // monitoring does not need to track changes, and it adds overhead to leave it on
  trackChanges: boolean;
  // allows monitoring to continue tracking renders even if react scan dev mode is disabled
  forceAlwaysTrackRenders?: boolean;
}

interface InstrumentationInstance {
  key: string;
  config: InstrumentationConfig;
  instrumentation: Instrumentation;
}

interface Instrumentation {
  isPaused: Signal<boolean>;
  fiberRoots: Set<FiberRoot>;
}

const instrumentationInstances = new Map<string, InstrumentationInstance>();
let inited = false;

const getAllInstances = () => Array.from(instrumentationInstances.values());

interface IsRenderUnnecessaryState {
  isRequiredChange: boolean;
}

function isRenderUnnecessaryTraversal(
  this: IsRenderUnnecessaryState,
  prevValue: unknown,
  nextValue: unknown,
): void {
  if (
    !isEqual(prevValue, nextValue) &&
    !isValueUnstable(prevValue, nextValue)
  ) {
    this.isRequiredChange = true;
  }
}

export const isRenderUnnecessary = (fiber: Fiber) => {
  if (!didFiberCommit(fiber)) return true;

  const mutatedHostFibers = getMutatedHostFibers(fiber);
  for (const mutatedHostFiber of mutatedHostFibers) {
    const state: IsRenderUnnecessaryState = {
      isRequiredChange: false,
    };
    traverseProps(mutatedHostFiber, isRenderUnnecessaryTraversal.bind(state));
    if (state.isRequiredChange) return false;
  }
  return true;
};

const shouldTrackUnnecessaryRenders = () => {
  // yes, this can be condensed into one conditional, but ifs are easier to reason/build on than long boolean expressions
  if (!ReactScanInternals.options.value.trackUnnecessaryRenders) {
    return false;
  }

  const isProd = getIsProduction();

  // only run advanced render checks when monitoring is active in production if the user set dangerouslyForceRunInProduction
  if (
    isProd &&
    Store.monitor.value &&
    ReactScanInternals.options.value.dangerouslyForceRunInProduction &&
    ReactScanInternals.options.value.trackUnnecessaryRenders
  ) {
    return true;
  }

  if (isProd && Store.monitor.value) {
    return false;
  }

  return ReactScanInternals.options.value.trackUnnecessaryRenders;
};

export const createInstrumentation = (
  instanceKey: string,
  config: InstrumentationConfig,
) => {
  const instrumentation: Instrumentation = {
    // this will typically be false, but in cases where a user provides showToolbar: true, this will be true
    isPaused: signal(!ReactScanInternals.options.value.enabled),
    fiberRoots: new Set<FiberRoot>(),
  };
  instrumentationInstances.set(instanceKey, {
    key: instanceKey,
    config,
    instrumentation,
  });
  if (!inited) {
    inited = true;
    const visitor = createFiberVisitor({
      onRender(fiber, phase) {
        const type = getType(fiber.type);
        if (!type) return null;

        const allInstances = getAllInstances();
        const validInstancesIndicies: Array<number> = [];
        for (let i = 0, len = allInstances.length; i < len; i++) {
          const instance = allInstances[i];
          if (!instance.config.isValidFiber(fiber)) continue;
          validInstancesIndicies.push(i);
        }
        if (!validInstancesIndicies.length) return null;

        const changes: Array<RenderChange> = [];

        if (config.trackChanges) {
          const propsChanges = getPropsChanges(fiber);
          const stateChanges = getStateChanges(fiber);
          const contextChanges = getContextChanges(fiber);

          for (let i = 0, len = propsChanges.length; i < len; i++) {
            const change = propsChanges[i];
            changes.push(change);
          }
          for (let i = 0, len = stateChanges.length; i < len; i++) {
            const change = stateChanges[i];
            changes.push(change);
          }
          for (let i = 0, len = contextChanges.length; i < len; i++) {
            const change = contextChanges[i];
            changes.push(change);
          }
        }

        const { selfTime } = getTimings(fiber);

        const fps = getFPS();

        const render: Render = {
          phase,
          componentName: getDisplayName(type),
          count: 1,
          changes,
          time: selfTime,
          forget: hasMemoCache(fiber),
          // todo: allow this to be toggle-able through toolbar
          // todo: performance optimization: if the last fiber measure was very off screen, do not run isRenderUnnecessary
          unnecessary: shouldTrackUnnecessaryRenders()
            ? isRenderUnnecessary(fiber)
            : null,

          didCommit: didFiberCommit(fiber),
          fps,
        };

        for (let i = 0, len = validInstancesIndicies.length; i < len; i++) {
          const index = validInstancesIndicies[i];
          const instance = allInstances[index];
          instance.config.onRender(fiber, [render]);
        }
      },
      onError(error) {
        const allInstances = getAllInstances();
        for (const instance of allInstances) {
          instance.config.onError(error);
        }
      },
    });
    instrument({
      name: 'react-scan',
      onActive: config.onActive,
      onCommitFiberRoot(rendererID, root) {
        if (
          ReactScanInternals.instrumentation?.isPaused.value &&
          (Store.inspectState.value.kind === 'inspect-off' ||
            Store.inspectState.value.kind === 'uninitialized') &&
          !config.forceAlwaysTrackRenders
        ) {
          return;
        }
        const allInstances = getAllInstances();
        for (const instance of allInstances) {
          instance.config.onCommitStart();
        }
        visitor(rendererID, root);
        for (const instance of allInstances) {
          instance.config.onCommitFinish();
        }
      },
    });
  }
  return instrumentation;
};
