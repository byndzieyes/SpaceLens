import { CategoryDonut } from './CategoryDonut'
import { InsightsAnalyticsSection } from './InsightsAnalyticsSection'
import { useInsightsRead, type InsightsSectionProps } from './useInsightsRead'

const readCategories = (scanId: string): ReturnType<Window['spaceLens']['getInsightsCategories']> =>
  window.spaceLens.getInsightsCategories({ scanId })

export function InsightsCategoriesSection(props: InsightsSectionProps): React.JSX.Element {
  const { state, retry } = useInsightsRead(props, readCategories, undefined)

  return (
    <InsightsAnalyticsSection
      title="File categories"
      description="Share of known logical file sizes by category."
      pageTitle={props.pageTitle}
      state={state}
      retry={retry}
      retryLabel="Retry categories"
    >
      {state.status === 'ready' && <CategoryDonut data={state.data} />}
    </InsightsAnalyticsSection>
  )
}
