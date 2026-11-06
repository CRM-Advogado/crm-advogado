import * as React from "react"
import { Input as InputPrimitive } from "@base-ui/react/input"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <InputPrimitive
      type={type}
      data-slot="input"
      className={cn(
        'border-input bg-card file:text-foreground placeholder:text-muted-foreground focus-visible:border-foreground focus-visible:ring-foreground disabled:bg-input/50 aria-invalid:border-destructive aria-invalid:ring-destructive h-8 w-full min-w-0 rounded-lg border px-2.5 py-1 text-base motion-safe:transition-[border-color,box-shadow] outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium focus-visible:ring-2 disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2 md:text-sm',
        className
      )}
      {...props}
    />
  )
}

export { Input }
