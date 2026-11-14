import { useEffect, useRef, useState } from 'react'
import type { PublicRecipe } from './arneyRecipeDiscovery.mjs'
import './ArneyRecipeCarousel.css'

type Props = { recipes: PublicRecipe[]; onReviewSave: (recipe: PublicRecipe) => void }

export default function ArneyRecipeCarousel({ recipes, onReviewSave }: Props) {
  const [index, setIndex] = useState(0)
  const [visibleCount, setVisibleCount] = useState(5)
  const touchStart = useRef<{x:number;y:number}|null>(null)
  useEffect(() => { setIndex(0); setVisibleCount(5) }, [recipes])
  const visible = Math.min(visibleCount, recipes.length)
  const item = recipes[index]
  if (!item) return null
  function advance(direction: number) {
    setIndex(current => Math.max(0, Math.min(visible - 1, current + direction)))
  }
  function nextBatch() {
    const next = Math.min(recipes.length, visibleCount + 5)
    setIndex(visibleCount)
    setVisibleCount(next)
  }
  return <section className="arney-recipe-browser" aria-label="Swipeable online recipe previews">
    <div className="arney-recipe-browser-top">
      <strong>Recipe previews</strong>
      <span aria-live="polite">{index + 1} of {visible} shown · {recipes.length} found</span>
    </div>
    <div className="arney-recipe-swipe-surface" tabIndex={0}
      aria-label={'Recipe ' + (index + 1) + ': ' + item.name + '. Swipe or use arrows.'}
      onKeyDown={event => {
        if (event.key === 'ArrowRight') { event.preventDefault(); advance(1) }
        if (event.key === 'ArrowLeft') { event.preventDefault(); advance(-1) }
      }}
      onTouchStart={event => {
        const t = event.changedTouches[0]; if(t)touchStart.current={x:t.clientX,y:t.clientY}
      }}
      onTouchEnd={event => {
        const t=event.changedTouches[0], start=touchStart.current; touchStart.current=null
        if(!t||!start)return
        const dx=t.clientX-start.x,dy=t.clientY-start.y
        if(Math.abs(dx)>55&&Math.abs(dx)>Math.abs(dy)*1.3)advance(dx<0?1:-1)
      }}>
      {item.image ?
        <img className="arney-recipe-photo" src={item.image} alt={'Photo of ' + item.name}
          loading="lazy" referrerPolicy="no-referrer" /> :
        <div className="arney-recipe-photo-placeholder" aria-label="No photo available">🍽</div>}
      <div className="arney-recipe-heading">
        <h3>{item.name}</h3>
        <span>{[item.category,item.area].filter(Boolean).join(' · ')}</span>
      </div>
      {item.matchNotes.length>0 && <div className="arney-recipe-match-notes">
        {item.matchNotes.map((note,i)=><span key={i}>{note}</span>)}
      </div>}
      <details className="arney-recipe-details">
        <summary>Ingredients ({item.ingredients.length})</summary>
        {item.ingredients.length ? <ul>{item.ingredients.map((line,i)=><li key={i}>{line}</li>)}</ul> :
          <p>Ingredients aren't listed by this source.</p>}
      </details>
      <details className="arney-recipe-details">
        <summary>Cooking instructions</summary>
        <p>{item.instructions || 'Instructions are unavailable from this source.'}</p>
      </details>
      <a className="arney-recipe-source" href={item.url} target="_blank" rel="noopener noreferrer">View original recipe on TheMealDB</a>
    </div>
    <div className="arney-recipe-nav">
      <button type="button" onClick={() => advance(-1)} disabled={index===0}
        aria-label="Previous recipe">‹ Previous</button>
      <button type="button" onClick={() => advance(1)}
        disabled={index>=visible-1} aria-label="Next recipe">Next ›</button>
    </div>
    <div className="arney-recipe-actions">
      <button type="button" className="arney-recipe-skip"
        onClick={() => index<visible-1 ? advance(1) : visible<recipes.length ? nextBatch() : setIndex(0)}>
        Skip</button>
      <button type="button" className="arney-recipe-save"
        onClick={() => onReviewSave(item)}>Save to Recipes</button>
    </div>
    {visible<recipes.length ?
      <button className="arney-recipe-more" type="button" onClick={nextBatch}>
        Find {Math.min(5,recipes.length-visible)} More</button> :
      <p className="arney-recipe-end">That's all the matching recipes returned by this search.</p>}
    <p className="arney-recipe-help">Recipe matches are suggestions. Review ingredients and cooking instructions before saving.</p>
  </section>
}
