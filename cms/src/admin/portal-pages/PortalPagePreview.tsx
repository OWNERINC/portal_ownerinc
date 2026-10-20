import React from 'react'
import type { ReactNode } from 'react'
import type { PortalPageDTO } from '../../portal-pages/contracts'
import type { PortalPageBlock, PortalPageInline, PortalPageMark, PortalPageRichNode } from '../../portal-pages/blocks'

export function assetURL(dto: PortalPageDTO, assetID: string): string {
  return `/editorial/api/portal-page-editorial/preview-assets/${dto.id}/${dto.revision.id}/${assetID}`
}

function unreachable(value: never): never {
  throw new Error('invalid_preview_block')
}

function markNode(mark: PortalPageMark, child: ReactNode, key: string): ReactNode {
  switch (mark) {
    case 'bold': return <strong key={key}>{child}</strong>
    case 'italic': return <em key={key}>{child}</em>
    case 'underline': return <u key={key}>{child}</u>
    case 'code': return <code key={key}>{child}</code>
    default: return unreachable(mark)
  }
}

function safeHTTPS(value: string): string | null {
  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return null
    return parsed.toString()
  } catch { return null }
}

function safeEmbedURL(provider: 'youtube' | 'vimeo', value: string): string | null {
  const safe = safeHTTPS(value)
  if (!safe) return null
  const parsed = new URL(safe)
  if (provider === 'youtube' && parsed.hostname === 'www.youtube.com' &&
    /^\/embed\/[A-Za-z0-9_-]{11}$/u.test(parsed.pathname) && parsed.search === '' && parsed.hash === '') return safe
  if (provider === 'vimeo' && parsed.hostname === 'player.vimeo.com' &&
    /^\/video\/[1-9][0-9]*$/u.test(parsed.pathname) && parsed.search === '' && parsed.hash === '') return safe
  return null
}

function renderInline(node: PortalPageInline, key: string): ReactNode {
  switch (node.type) {
    case 'text':
      return node.marks.reduceRight<ReactNode>((child, mark, index) => markNode(mark, child, `${key}-mark-${index}`), node.text)
    case 'break': return <br key={key} />
    case 'link': {
      const href = safeHTTPS(node.url)
      const content = node.children.map((child, index) => renderInline(child, `${key}-child-${index}`))
      return href ? <a key={key} href={href} {...(node.new_tab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{content}</a>
        : <span key={key}>{content}</span>
    }
    default: return unreachable(node)
  }
}

function renderRichNode(node: PortalPageRichNode, key: string): ReactNode {
  switch (node.type) {
    case 'paragraph': return <p key={key}>{node.children.map((child, index) => renderInline(child, `${key}-inline-${index}`))}</p>
    case 'heading': {
      const content = node.children.map((child, index) => renderInline(child, `${key}-inline-${index}`))
      switch (node.level) {
        case 2: return <h2 key={key}>{content}</h2>
        case 3: return <h3 key={key}>{content}</h3>
        case 4: return <h4 key={key}>{content}</h4>
        case 5: return <h5 key={key}>{content}</h5>
        case 6: return <h6 key={key}>{content}</h6>
        default: return unreachable(node.level)
      }
    }
    case 'list': {
      const items = node.items.map((item, index) => <li key={`${key}-item-${index}`}>
        {item.map((child, childIndex) => renderInline(child, `${key}-item-${index}-inline-${childIndex}`))}
      </li>)
      return node.ordered ? <ol key={key}>{items}</ol> : <ul key={key}>{items}</ul>
    }
    default: return unreachable(node)
  }
}

function heading(level: 2 | 3 | 4, text: string, key: string): ReactNode {
  switch (level) {
    case 2: return <h2 key={key}>{text}</h2>
    case 3: return <h3 key={key}>{text}</h3>
    case 4: return <h4 key={key}>{text}</h4>
    default: return unreachable(level)
  }
}

function blockContent(dto: PortalPageDTO, block: PortalPageBlock, key: string): ReactNode {
  switch (block.type) {
    case 'heading': return heading(block.level, block.text, key)
    case 'rich_text': return block.nodes.map((node, index) => renderRichNode(node, `${key}-rich-${index}`))
    case 'image': return <figure key={key}>
      <img src={assetURL(dto, block.asset_id)} alt={block.alt} />
      {block.caption && <figcaption>{block.caption}</figcaption>}
    </figure>
    case 'gallery': return <ol key={key} className="portal-page-preview__gallery" aria-label="Galeria de imagens">
      {block.images.map((image, index) => <li key={`${key}-image-${index}`}><figure>
        <img src={assetURL(dto, image.asset_id)} alt={image.alt} />
        {image.caption && <figcaption>{image.caption}</figcaption>}
      </figure></li>)}
    </ol>
    case 'video': return <figure key={key}>
      <video controls preload="metadata" aria-label={block.title}>
        <source src={assetURL(dto, block.asset_id)} />
        Seu navegador não oferece reprodução de vídeo.
      </video>
      <figcaption>{block.title}</figcaption>
    </figure>
    case 'pdf': {
      const href = assetURL(dto, block.asset_id)
      return <section key={key} className="portal-page-preview__pdf" aria-label={block.title}>
        <object data={href} type="application/pdf" aria-label={block.title}>
          <p>O PDF não pôde ser exibido. <a href={href}>{`Abrir ${block.title}`}</a></p>
        </object>
        <a href={href}>{`Abrir documento: ${block.title}`}</a>
      </section>
    }
    case 'embed': {
      const src = safeEmbedURL(block.provider, block.url)
      return src ? <figure key={key} className="portal-page-preview__embed">
        <iframe src={src} title={block.title} loading="lazy" referrerPolicy="strict-origin-when-cross-origin"
          allowFullScreen />
        <figcaption>{block.title}</figcaption>
      </figure> : <p key={key}>Este vídeo incorporado não está disponível.</p>
    }
    case 'callout': {
      const toneNames = { info: 'Informação', warning: 'Atenção', success: 'Sucesso' } as const
      const label = block.title || toneNames[block.tone]
      return <aside key={key} className={`portal-page-preview__callout portal-page-preview__callout--${block.tone}`}
        aria-label={label}>
        {block.title && <h2>{block.title}</h2>}
        <p>{block.text}</p>
      </aside>
    }
    case 'link': {
      const href = safeHTTPS(block.url)
      return href ? <p key={key}>
        <a className={`portal-page-preview__link portal-page-preview__link--${block.style}`} href={href}
          {...(block.new_tab ? { target: '_blank', rel: 'noopener noreferrer' } : {})}>{block.label}</a>
      </p> : <p key={key}>{block.label}</p>
    }
    case 'divider': return <hr key={key} />
    default: return unreachable(block)
  }
}

function layoutClass(block: PortalPageBlock): string {
  const layout = block.layout || 'content'
  switch (layout) {
    case 'content': return 'portal-page-preview__block--content'
    case 'wide': return 'portal-page-preview__block--wide'
    case 'full': return 'portal-page-preview__block--full'
    case 'left': return 'portal-page-preview__block--left'
    case 'right': return 'portal-page-preview__block--right'
    default: return unreachable(layout)
  }
}

export function PortalPagePreview(props: { dto: PortalPageDTO; savedAt: string }): React.JSX.Element {
  const { dto } = props
  return <article className="portal-page-preview" aria-labelledby="portal-page-preview-title">
    {dto.cover && <figure className="portal-page-preview__cover">
      <img src={assetURL(dto, dto.cover.asset_id)} alt={dto.cover.alt} />
    </figure>}
    <header className="portal-page-preview__header">
      <p className="portal-page-preview__summary">{dto.summary}</p>
      <h1 id="portal-page-preview-title">{dto.title}</h1>
    </header>
    <div className="portal-page-preview__body">
      {dto.content_blocks.map((block, index) => <section key={`${block.type}-${index}`}
        className={`portal-page-preview__block ${layoutClass(block)}`}>
        {blockContent(dto, block, `block-${index}`)}
      </section>)}
    </div>
  </article>
}
