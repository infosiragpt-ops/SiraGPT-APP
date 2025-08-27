"use client"

import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DownloadButtons } from './download-buttons';

export function DownloadDemo() {
  const sampleTableContent = `Here are the top 10 countries by population:

| Country | Population (millions) | Capital | GDP (trillion USD) |
|---------|----------------------|---------|-------------------|
| China | 1,439 | Beijing | 17.7 |
| India | 1,380 | New Delhi | 3.7 |
| United States | 331 | Washington D.C. | 26.9 |
| Indonesia | 273 | Jakarta | 1.3 |
| Pakistan | 225 | Islamabad | 0.35 |
| Brazil | 215 | Brasília | 2.1 |
| Nigeria | 211 | Abuja | 0.44 |
| Bangladesh | 166 | Dhaka | 0.46 |
| Russia | 146 | Moscow | 1.8 |
| Mexico | 130 | Mexico City | 1.3 |

This data shows the most populous countries with their basic economic indicators.`;

  return (
    <Card className="p-6 max-w-4xl mx-auto">
      <h2 className="text-xl font-semibold mb-4">Download Functionality Demo</h2>
      <div className="prose prose-sm dark:prose-invert max-w-none mb-4">
        <div dangerouslySetInnerHTML={{ __html: sampleTableContent.replace(/\n/g, '<br>') }} />
      </div>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-foreground">Try downloading this data:</span>
        <DownloadButtons content={sampleTableContent} messageId="demo-message" />
      </div>
    </Card>
  );
}