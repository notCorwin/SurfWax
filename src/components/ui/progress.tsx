import * as React from "react"
import { Progress as ProgressPrimitive } from "@base-ui/react/progress"
import { stateClasses } from "@/classes"

function Progress({
  className,
  value,
  ...props
}: React.ComponentProps<typeof ProgressPrimitive.Root>) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={stateClasses(
        "relative h-2 w-full overflow-hidden rounded-full bg-primary/20",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className="h-full bg-primary transition-[width] duration-(--motion-normal)"
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
