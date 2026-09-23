'use client';

/**
 * 资产选择下拉。三处共用：调试页的 G0 资产、动作库的主角色、动作库的对照角色。
 *
 * 一个容易忽略的细节：**当前值可能不在列表里**。
 * `?avatar=` 可以指向 `public/avatars/` 之外（比如临时转换出来放在别处的文件），
 * 此时若直接把列表当选项，`<select value>` 匹配不到任何 option，
 * React 会把下拉显示成空白 —— 看起来像"没选任何资产"。
 * 所以这里显式把当前值补成一项。
 */
import { useAvatars, avatarLabel, type AvatarEntry } from '@/lib/use-avatars';

export default function AvatarSelect({
  value,
  onChange,
  className,
  ariaLabel,
  disabled = false,
}: {
  value: string;
  onChange: (url: string) => void;
  className?: string;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const { assets } = useAvatars(value);

  const options: AvatarEntry[] = assets.some((a) => a.url === value)
    ? assets
    : [
        ...assets,
        {
          url: value,
          file: value.split('/').pop() ?? value,
          bytes: 0,
          name: null,
          boneCount: null,
          specVersion: null,
        },
      ];

  return (
    <select
      className={className}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label={ariaLabel}
      disabled={disabled}
    >
      {options.map((a) => (
        <option key={a.url} value={a.url}>
          {avatarLabel(a)}
        </option>
      ))}
    </select>
  );
}
