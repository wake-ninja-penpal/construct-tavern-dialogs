/**
 * Санитизация HTML заметок — порт sanitizeNoteHtml из прототипа
 * (удаляет скрипты, стили, iframe, on*-атрибуты и javascript:-ссылки).
 */

export function sanitizeNoteHtml(html: string): string {
  if (typeof window === 'undefined' || typeof DOMParser === 'undefined') return String(html || '')
  try {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
    doc.querySelectorAll('script,style,iframe,object,embed,link,meta').forEach((el) => el.remove())
    doc.querySelectorAll('*').forEach((el) => {
      Array.from(el.attributes).forEach((attr) => {
        const an = attr.name.toLowerCase()
        if (an.startsWith('on')) el.removeAttribute(attr.name)
        if ((an === 'href' || an === 'src') && /^\s*javascript:/i.test(attr.value)) el.removeAttribute(attr.name)
      })
    })
    return doc.body.innerHTML
  } catch {
    return ''
  }
}
