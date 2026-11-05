'use client'

import { iconPath } from '@/lib/vetvi/icons'

export function Icon({ name, size = 15 }: { name: string; size?: number }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      dangerouslySetInnerHTML={{ __html: iconPath(name) }}
    />
  )
}
