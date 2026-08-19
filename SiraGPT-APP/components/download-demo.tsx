"use client"

import React from 'react';
import { Card } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { DownloadButtons } from './download-buttons';

export function DownloadDemo() {
  const sampleTableContent = `Here are examples of derivatives:

Derivative of a constant:
If $f(x) = 5$, then the derivative is: $f'(x) = \\frac{d}{dx}(5) = 0$

Derivative of $x^n$:
If $f(x) = x^n$, then: $f'(x) = nx^{n-1}$

So, for example, if $f(x) = x^3$, then $f'(x) = 3x^2$.

Derivative of $e^x$:
If $f(x) = e^x$, then: $f'(x) = e^x$

Derivative of $\\sin(x)$:
If $f(x) = \\sin(x)$, then: $f'(x) = \\cos(x)$

Derivative using the product rule:
If $f(x) = x^2\\sin(x)$, then: $f'(x) = \\frac{d}{dx}(x^2\\sin(x)) = 2x\\sin(x) + x^2\\cos(x)$

Derivative using the chain rule:
If $f(x) = (3x+1)^4$, then: $f'(x) = 4(3x+1)^3 \\cdot 3 = 12(3x+1)^3$

This demonstrates how mathematical content is properly formatted for downloads.`;

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