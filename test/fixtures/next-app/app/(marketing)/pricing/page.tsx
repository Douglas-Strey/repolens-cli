const plans = [
  { name: 'Hobby', price: 0 },
  { name: 'Team', price: 29 },
  { name: 'Enterprise', price: 99 },
]

export default function PricingPage() {
  return (
    <main>
      <h1>Pricing</h1>
      <ul>
        {plans.map((plan) => (
          <li key={plan.name}>
            {plan.name}: ${plan.price}/mo
          </li>
        ))}
      </ul>
    </main>
  )
}
