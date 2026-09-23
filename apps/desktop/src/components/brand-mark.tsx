import { cn } from '@/lib/utils'

const assetPath = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\/+/, '')}`

// Shared UniWork brand mark used by About, updates, setup, and onboarding.
// Keep it on a transparent tile so the packaged-app and web identities match.
export function BrandMark({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span
      className={cn('inline-flex size-14 shrink-0 items-center justify-center overflow-hidden rounded-md', className)}
      {...props}
    >
      <img alt="" className="size-full object-contain" src={assetPath('apple-touch-icon.png')} />
    </span>
  )
}
