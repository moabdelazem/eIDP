import { Braces } from 'lucide-react'
import { DataView } from '@/components/data-view.tsx'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

/**
 * The raw record behind a page, one click away instead of a long block at the
 * bottom of it. For data people consult now and then — a request's stored
 * fields, what the directory returned — not data that is the page's point.
 */
export function DataDialog({
  data,
  filename,
  title,
  description,
  label = 'View data',
}: {
  data: unknown
  filename: string
  title: string
  description?: string
  label?: string
}) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button size="sm" variant="outline">
          <Braces /> {label}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        <DataView data={data} filename={filename} />
      </DialogContent>
    </Dialog>
  )
}
