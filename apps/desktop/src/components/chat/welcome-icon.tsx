import { DynamicIcon, type IconName, iconNames } from 'lucide-react/dynamic'

const SUPPORTED_ICONS = new Set<string>(iconNames)

interface WelcomeIconProps {
  name?: string
  className?: string
  size?: number
}

/** 云端只指定 Lucide 名称；缺失或不支持的名称不替换成其他业务图标。 */
export function WelcomeIcon({ name, className, size }: WelcomeIconProps) {
  if (!name || !SUPPORTED_ICONS.has(name)) {
    return null
  }

  return <DynamicIcon aria-hidden="true" className={className} fallback={() => null} name={name as IconName} size={size} />
}
