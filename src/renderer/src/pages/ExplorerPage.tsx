import { FolderTree } from 'lucide-react'
import { PagePlaceholder } from './PagePlaceholder'

export function ExplorerPage(): React.JSX.Element {
  return (
    <PagePlaceholder
      title="Explore your storage"
      description="Folder browsing and storage visualization will be available here."
      icon={FolderTree}
    />
  )
}
