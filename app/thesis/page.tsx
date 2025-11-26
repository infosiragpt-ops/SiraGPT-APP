import ThesisGenerator from "@/components/ThesisGenerator"

export default function ThesisPage() {
  return (
    <div className="container mx-auto p-6 max-w-4xl">
      <div className="mb-6">
        <h1 className="text-3xl font-bold mb-2">Thesis Generator</h1>
        <p className="text-muted-foreground">
          Generate comprehensive academic theses from multiple research topics
        </p>
      </div>
      <ThesisGenerator />
    </div>
  )
}

