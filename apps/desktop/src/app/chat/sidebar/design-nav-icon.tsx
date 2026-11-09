import type { ComponentProps } from 'react'

import capabilities from '@/assets/sidebar/capabilities.svg'
import cloud from '@/assets/sidebar/cloud.svg'
import phone from '@/assets/sidebar/connect-phone.svg'
import mail from '@/assets/sidebar/mail.svg'
import task from '@/assets/sidebar/new-task.svg'
import clock from '@/assets/sidebar/scheduled-tasks.svg'

const icons = { capabilities, cloud, phone, mail, task, clock }

interface DesignNavIconProps extends ComponentProps<'span'> {
  name: keyof typeof icons
}

/** Original MasterGo vectors, tinted through the active theme's text color. */
export function DesignNavIcon({ name, style, ...props }: DesignNavIconProps) {
  const mask = `url("${icons[name]}") center / contain no-repeat`
  return <span {...props} aria-hidden="true" style={{ display: 'inline-block', backgroundColor: 'currentColor', mask, WebkitMask: mask, ...style }} />
}
