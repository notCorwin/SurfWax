import * as React from "react"
import { classes } from "@/classes"

type BadgeVariant = "default" | "secondary" | "destructive" | "outline" | "ghost" | "link"

const badgeClasses = [
  "inline-flex w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-full border border-transparent px-2 py-0.5 text-xs font-medium whitespace-nowrap transition-[color,box-shadow] aria-invalid:border-destructive [&>svg]:pointer-events-none [&>svg]:size-3",
  "data-[variant=default]:bg-primary data-[variant=default]:text-primary-foreground",
  "data-[variant=secondary]:bg-secondary data-[variant=secondary]:text-secondary-foreground",
  "data-[variant=destructive]:bg-destructive data-[variant=destructive]:text-destructive-foreground dark:data-[variant=destructive]:bg-destructive/60",
  "data-[variant=outline]:border-border data-[variant=outline]:text-foreground",
  "data-[variant=link]:text-primary data-[variant=link]:underline-offset-4",
].join(" ")

function Badge({
  className,
  variant = "default",
  ...props
}: React.ComponentProps<"span"> & { variant?: BadgeVariant }) {
  return (
    <span
      data-slot="badge"
      data-variant={variant}
      className={classes(badgeClasses, className)}
      {...props}
    />
  )
}

export { Badge }
