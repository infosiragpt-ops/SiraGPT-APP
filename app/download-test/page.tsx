"use client"

import { DownloadDemo } from '@/components/download-demo';

export default function DownloadTestPage() {
  return (
    <div className="container mx-auto py-8">
      <h1 className="text-2xl font-bold mb-6 text-center">AI Response Download Test</h1>
      <DownloadDemo />
      
      <div className="mt-8 max-w-4xl mx-auto">
        <h2 className="text-lg font-semibold mb-4">How it works:</h2>
        <ul className="list-disc list-inside space-y-2 text-sm text-muted-foreground">
          <li>The system automatically detects tabular data in AI responses</li>
          <li>When tables are found, CSV and Excel download options appear</li>
          <li>Word and Text downloads are always available for any response</li>
          <li>Files are generated client-side for better performance</li>
          <li>Fallback to server-side generation if needed</li>
        </ul>
      </div>
    </div>
  );
}