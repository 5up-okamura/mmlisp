; GMLisp demo skeleton 1
; Purpose: loop/marker stability + base/delta modulation

(score :id :demo1-stage-loop
  :title "Demo 1 Stage Loop"
  :author "okamura"

  (part :main
    :loop true
    :ch [:fm1]

    (phrase :riff
      :tempo 120
      :len 1/8

      (marker :intro)
      (note :c4)
      (note :e4)
      (note :g4)
      (rest 1/8)

      (param-set :fm-fb 2)
      (param-add :fm-fb +1)

      (marker :turn)
      (jump :intro))))
