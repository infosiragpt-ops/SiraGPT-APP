import { Header } from "./components/Header"
import { useCart } from "./hooks/useCart"
export default function App() {
  useCart()
  return Header
}
