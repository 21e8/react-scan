import type { Render } from './instrumentation/index';

export const NO_OP = () => {
  /**/
};

export const getLabelText = (renders: Render[]) => {
  let labelText = '';

  const components = new Map<
    string,
    {
      count: number;
      time: number;
      trigger: boolean;
      forget: boolean;
    }
  >();

  for (let i = 0, len = renders.length; i < len; i++) {
    const render = renders[i];
    const name = render.name;
    if (!name?.trim()) continue;

    const { count, time, trigger, forget } = components.get(name) ?? {
      count: 0,
      time: 0,
      trigger: false,
      forget: false,
    };
    components.set(name, {
      count: count + render.count,
      time: time + render.time,
      trigger: trigger || render.trigger,
      forget: forget || render.forget,
    });
  }

  const sortedComponents = Array.from(components.entries()).sort(
    ([nameA, a], [nameB, b]) => {
      if (a.trigger !== b.trigger) {
        return a.trigger ? -1 : 1;
      }
      if (b.count !== a.count) {
        return b.count - a.count;
      }
      return nameA.localeCompare(nameB);
    },
  );

  const parts: string[] = [];
  for (const [name, { count, time, trigger, forget }] of sortedComponents) {
    let text = name;
    if (count > 1) {
      text += ` ×${count}`;
    }
    const roundedTime = time.toFixed(0);
    if (time > 0 && roundedTime !== '0') {
      text += ` (${roundedTime}ms)`;
    }
    if (trigger) {
      text = `🔥 ${text}`;
    }
    if (forget) {
      text = `${text} ✨`;
    }
    parts.push(text);
  }

  labelText = parts.join(', ');

  if (!labelText.length) return null;
  if (labelText.length > 30) {
    labelText = `${labelText.slice(0, 30)}…`;
  }
  return labelText;
};
