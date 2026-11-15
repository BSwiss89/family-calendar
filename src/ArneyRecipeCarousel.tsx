import { useEffect, useRef, useState } from 'react'
import type { PublicRecipe } from './arneyRecipeDiscovery.mjs'
import './ArneyRecipeCarousel.css'

type Props = { recipes: PublicRecipe[]; onReviewSave: (recipe: PublicRecipe) => void }

// Native horizontal scrolling moves the actual page under the finger.
// CSS scroll snap completes the page-turn; buttons and keyboard use that track.
export default function ArneyRecipeCarousel({ recipes, onReviewSave }: Props) {
  const [index, setIndex] = useState(0)
  const [position, setPosition] = useState(0)
  const viewport = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setIndex(0)
    setPosition(0)
    if (viewport.current) viewport.current.scrollLeft = 0
  }, [recipes])

  if (recipes.length === 0) return null
  const selectedIndex = Math.min(index, recipes.length - 1)
  const selected = recipes[selectedIndex]
  if (!selected) return null

  function goTo(next: number) {
    const target = Math.max(0, Math.min(recipes.length - 1, next))
    setIndex(target)
    viewport.current?.scrollTo({
      left: target * viewport.current.clientWidth,
      behavior: 'smooth',
    })
  }

  function handleScroll() {
    const element = viewport.current
    if (!element || element.clientWidth <= 0) return
    const nextPosition = Math.max(0, Math.min(recipes.length - 1,
      element.scrollLeft / element.clientWidth))
    setPosition(nextPosition)
    setIndex(Math.round(nextPosition))
  }

  return <section className="arney-recipe-browser" aria-label="Online recipe previews">
    <div className="arney-recipe-browser-top">
      <strong>Recipe previews</strong>
      <span aria-live="polite">{selectedIndex + 1} of {recipes.length}</span>
    </div>
    <div
      ref={viewport}
      className="arney-recipe-swipe-surface"
      role="region"
      aria-roledescription="carousel"
      aria-label="Swipe through all returned recipes"
      tabIndex={0}
      onScroll={handleScroll}
      onKeyDown={event => {
        if (event.target !== event.currentTarget) return
        if (event.key === 'ArrowRight') { event.preventDefault(); goTo(selectedIndex + 1) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); goTo(selectedIndex - 1) }
      }}
    >
      {recipes.map((item, i) => {
        const difference = i - position
        const turn = Math.max(-10, Math.min(10, -10 * difference))
        const scale = 1 - Math.min(1, Math.abs(difference)) * .025
        return <article
          key={item.id}
          className="arney-recipe-page"
          aria-label={'Recipe ' + (i + 1) + ' of ' + recipes.length + ': ' + item.name}
          style={{ transform: 'perspective(1000px) rotateY(' + turn + 'deg) scale(' + scale + ')' }}
        >
          {item.image ?
            <img className="arney-recipe-photo" src={item.image}
              alt={'Photo of ' + item.name} loading="lazy" referrerPolicy="no-referrer" /> :
            <div className="arney-recipe-photo-placeholder" aria-label="No photo available">🍽</div>}
          <div className="arney-recipe-heading">
            <h3>{item.name}</h3>
            <span>{[item.category, item.area].filter(Boolean).join(' · ')}</span>
          </div>
          {item.matchNotes.length > 0 && <div className="arney-recipe-match-notes">
            {item.matchNotes.map((note, j) => <span key={j}>{note}</span>)}
          </div>}
          <details className="arney-recipe-details">
            <summary>Ingredients ({item.ingredients.length})</summary>
            {item.ingredients.length ? <ul>{item.ingredients.map((line, j) => <li key={j}>{line}</li>)}</ul> :
              <p>Ingredients aren't listed by this source.</p>}
          </details>
          <details className="arney-recipe-details">
            <summary>Cooking instructions</summary>
            <p>{item.instructions || 'Instructions are unavailable from this source.'}</p>
          </details>
          <a className="arney-recipe-source" href={item.url} target="_blank"
            rel="noopener noreferrer">View original recipe on TheMealDB</a>
        </article>
      })}
    </div>
    <div className="arney-recipe-nav">
      <button type="button" onClick={() => goTo(selectedIndex - 1)} disabled={selectedIndex === 0}
        aria-label="Previous recipe">‹ Previous</button>
      <button type="button" onClick={() => goTo(selectedIndex + 1)}
        disabled={selectedIndex === recipes.length - 1} aria-label="Next recipe">Next ›</button>
    </div>
    <div className="arney-recipe-actions">
      <button type="button" className="arney-recipe-skip"
        onClick={() => goTo(selectedIndex === recipes.length - 1 ? 0 : selectedIndex + 1)}>
        {selectedIndex === recipes.length - 1 ? 'Back to first' : 'Skip'}
      </button>
      <button type="button" className="arney-recipe-save"
        onClick={() => onReviewSave(selected)}>Save to Recipes</button>
    </div>
    {selectedIndex === recipes.length - 1 && <p className="arney-recipe-end">
      That's all {recipes.length} recipes returned by this search.
    </p>}
    <p className="arney-recipe-help">Drag sideways to turn the page, or use the arrows.
      Recipe matches are suggestions. Review ingredients and instructions before saving.</p>
  </section>
}
