import { render, screen } from '@testing-library/react'
import Home from '../app/page'

describe('Home', () => {
  it('renders a heading', () => {
    render(<Home />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('Welcome')
  })

  it('links to the dashboard', () => {
    render(<Home />)
    expect(screen.getByRole('link', { name: 'Open dashboard' }).getAttribute('href')).toBe('/dashboard')
  })
})
