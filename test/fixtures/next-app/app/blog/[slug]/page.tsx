export default async function BlogPost({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params

  return (
    <article>
      <h1>{slug.replaceAll('-', ' ')}</h1>
    </article>
  )
}
