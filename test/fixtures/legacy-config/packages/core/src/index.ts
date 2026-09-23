import { slugify } from '@legacy/utils'

export function createPost(title: string) {
  return { title, slug: slugify(title), createdAt: new Date() }
}
